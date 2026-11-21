const seconds = (ms = Date.now()) => Math.floor(ms / 1000);
const DEV_STALE = 45;
const CREDS_DOMAIN = /@(kgpian\.)?iitkgp\.ac\.in$/i;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function createBoard(hall, now, seed, connected) {
  return {
    machines: Array.from({ length: hall.count }, (_, index) => ({
      id: index + 1,
      active: seed && index === 1 ? {
        owner: "sample", label: "Demo resident", phase: "running", end: now + 65, command: "sample"
      } : null,
      hold: null,
      line: [],
      device: connected ? { seen: 0, status: "offline" } : null
    })),
    events: []
  };
}

function notify(board, owner, machine, type, now) {
  if (!owner || owner === "sample") return;
  board.events.push({ id: crypto.randomUUID(), owner, washer: machine.id, type, at: now });
  board.events = board.events.filter(event => event.at >= now - 7 * 86400).slice(-250);
}

function promote(board, machine, at) {
  const next = machine.line.shift();
  machine.hold = next ? { ...next, end: at + HOLD_SECS } : null;
  if (next) notify(board, next.owner, machine, "turn", at);
}

function markDone(board, machine, at) {
  machine.active.phase = "unloading";
  machine.active.done = at;
  machine.active.end = null;
  notify(board, machine.active.owner, machine, "complete", at);
}

function clearWasher(board, machine, at) {
  machine.active = null;
  promote(board, machine, at);
}

function normalize(board, now, demo) {
  for (const machine of board.machines) {
    const active = machine.active;
    if (demo && active?.phase === "running" && active.end <= now) markDone(board, machine, active.end);
    if (demo && active?.phase === "unloading" && active.owner === "sample" && now - active.done >= 110) {
      clearWasher(board, machine, active.done + 110);
    }
    while (machine.hold && machine.hold.end <= now) promote(board, machine, machine.hold.end);
  }
}

function publicMachine(machine, owner, now, demo, provisioned = true) {
  const { id, active, hold, line, device } = machine;
  const index = line.findIndex(entry => entry.owner === owner);
  const offline = !demo && (!provisioned || !device || device.seen < now - DEV_STALE ||
    !["ready", "starting", "running", "unloading"].includes(device.status));
  return {
    id,
    state: offline ? "offline" : active?.phase || (hold ? "held" : "free"),
    end: active?.phase === "running" ? active.end : hold?.end ?? null,
    waiting: line.length,
    mine: owner ? (active?.owner === owner ? active.phase : hold?.owner === owner ? "held" : index >= 0 ? "waiting" : null) : null,
    position: index >= 0 ? index + 1 : null,
    pickup: index === 0 && active?.phase === "unloading" ? {
      label: active.owner === "sample" ? null : active.label,
      since: active.done,
      reminderAt: active.reminderAt || null,
      reported: Boolean(active.reported),
      reportAt: active.done + (demo ? 15 : 900)
    } : null
  };
}

function change(board, actor, input, now, config) {
  const { id: owner, name: label } = actor;
  const machine = board.machines.find(item => item.id === input.machine);
  if (!machine) throw new HttpError(404, "That washer does not exist in this hall.");
  const { action, duration } = input;
  const person = { owner, label };
  const existing = board.machines.find(item => item.active?.owner === owner || item.hold?.owner === owner || item.line.some(entry => entry.owner === owner));
  const { demo, hall, devices } = config;
  const deviceConfig = devices?.[`${hall.id}/${machine.id}`];
  const state = publicMachine(machine, owner, now, demo, !!deviceConfig);
  switch (action) {
    case "join":
      if (state.mine === "waiting" || state.mine === "held") return;
      if (existing) throw new HttpError(409, "Finish or release your current turn in this hall first.");
      if (state.state === "offline") throw new HttpError(409, "This washer is offline. Choose another washer.");
      if (state.state === "free") {
        machine.hold = { ...person, end: now + HOLD_SECS };
        notify(board, owner, machine, "turn", now);
        return;
      }
      if (machine.line.length >= 12) throw new HttpError(409, "This queue is full. Try another washer.");
      machine.line.push(person);
      return;
    case "start":
      if (!CYCLE_MINS.includes(duration)) throw new HttpError(400, "Choose one of the available cycle lengths.");
      if (state.mine === "running" || state.mine === "starting") return;
      if (existing && state.mine !== "held") throw new HttpError(409, "Finish or release your current turn in this hall first.");
      if (state.state !== "free" && !(state.state === "held" && state.mine === "held")) {
        throw new HttpError(409, "The washer cannot start in its current state.");
      }
      if (demo && input.label !== "demo-v2") throw new HttpError(403, "Scan this washer’s label.");
      if (!demo) {
        const device = machine.device;
        if (!deviceConfig?.labelKey || input.label !== deviceConfig.labelKey || !device.pin || device.pinUntil <= now) {
          throw new HttpError(403, "Scan this washer’s label and request a current on-site code.");
        }
        if ((device.pinAttempts || 0) >= 5) throw new HttpError(429, "Request a new code at the washer.");
        if (input.pin !== device.pin) {
          device.pinAttempts = (device.pinAttempts || 0) + 1;
          return new HttpError(403, "The on-site code doesn’t match.");
        }
        device.pin = null;
        device.pinUntil = null;
      }
      machine.hold = null;
      machine.active = {
        ...person, phase: demo ? "running" : "starting", duration,
        end: demo ? now + (duration - 5) : null, command: crypto.randomUUID(), issued: now
      };
      return;
    case "leave":
      if (state.mine === "waiting") machine.line = machine.line.filter(entry => entry.owner !== owner);
      if (state.mine === "held") promote(board, machine, now);
      return;
    case "complete":
      if (!demo || state.mine !== "running") throw new HttpError(409, "Waiting for the washer controller to confirm completion.");
      markDone(board, machine, now);
      return;
    case "collect":
      if (!demo || state.mine !== "unloading") throw new HttpError(409, "Waiting for the washer controller to confirm pickup.");
      clearWasher(board, machine, now);
      return;
    case "remind":
      if (!state.pickup || !state.pickup.label) throw new HttpError(403, "Only the next resident can remind the previous washer user.");
      if (machine.active.reminderAt && now - machine.active.reminderAt < (demo ? 20 : 120)) {
        throw new HttpError(429, "A reminder was sent recently. Give the resident a moment.");
      }
      machine.active.reminderAt = now;
      notify(board, machine.active.owner, machine, "reminder", now);
      return;
    case "report":
      if (!state.pickup || now < state.pickup.reportAt) throw new HttpError(409, "Hall help becomes available after the collection window.");
      if (!machine.active.reported) {
        machine.active.reported = now;
        notify(board, machine.active.owner, machine, "report", now);
      }
      return;
    default:
      throw new HttpError(400, "Choose a valid washer action.");
  }
}

function updateDevice(board, id, input, now) {
  const machine = board.machines.find(item => item.id === id);
  const device = machine.device;
  const active = machine.active;
  const { event, command } = input;
  if (event === "heartbeat") {
    device.seen = now;
    return;
  }
  if (event === "presence") {
    if (typeof input.pin !== "string" || !/^\d{6}$/.test(input.pin) || device.status !== "ready" || active) throw new HttpError(422, "Presence codes require an idle washer.");
    device.seen = now;
    device.pin = input.pin;
    device.pinAttempts = 0;
    device.pinUntil = now + 45;
    return;
  }
  if (event === "fault") {
    device.seen = now;
    device.status = "fault";
    device.pin = null;
    return;
  }
  if (event === "ready" && !active) {
    device.seen = now;
    device.status = "ready";
    return;
  }
  if (event === "clear" && command && device.lastClear === command) {
    device.seen = now;
    return;
  }
  if (!command || active?.command !== command) throw new HttpError(409, "Stale or unknown command ID.");
  if (event === "started" && active.phase === "starting" && now <= active.issued + 30) {
    active.phase = "running";
    active.end = now + active.duration * 60;
    device.status = "running";
  } else if (event === "complete" && active.phase === "running") {
    markDone(board, machine, now);
    device.status = "unloading";
  } else if (event === "clear" && active.phase === "unloading") {
    clearWasher(board, machine, now);
    device.lastClear = command;
    device.status = "ready";
  } else if (event === "rejected" && active.phase === "starting") {
    notify(board, active.owner, machine, "rejected", now);
    clearWasher(board, machine, now);
    device.status = "fault";
  } else if (!(event === "started" && active.phase === "running") && !(event === "complete" && active.phase === "unloading")) {
    throw new HttpError(409, "Event does not match the washer state.");
  }
  device.seen = now;
}

function deviceCommand(machine, now) {
  const active = machine.active;
  if (active?.phase !== "starting" || machine.device.status === "fault" || now > active.issued + 30) return null;
  return { id: active.command, expiresAt: active.issued + 30, requestedMinutes: active.duration };
}
