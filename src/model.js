const seconds = (ms = Date.now()) => Math.floor(ms / 1000);

function createBoard(hall, now, demo) {
  return Array.from({ length: hall.count }, (_, index) => ({
    id: index + 1,
    active: demo && index === 1 ? { owner: "demo", end: now + 18 * 60 } : null,
    hold: null,
    line: []
  }));
}

function promote(machine, at) {
  const next = machine.line.shift();
  machine.hold = next ? { owner: next, end: at + HOLD_SECS } : null;
}

function normalize(machines, now) {
  for (const machine of machines) {
    if (machine.active && machine.active.end <= now) {
      promote(machine, machine.active.end);
      machine.active = null;
    }
    while (machine.hold && machine.hold.end <= now) {
      promote(machine, machine.hold.end);
    }
  }
}

function publicMachine(machine, owner) {
  const { id, active, hold, line } = machine;
  const index = line.indexOf(owner);
  return {
    id,
    state: active ? "running" : hold ? "held" : "free",
    end: active?.end ?? hold?.end ?? null,
    waiting: line.length,
    mine: active?.owner === owner ? "running" : hold?.owner === owner ? "held" : index >= 0 ? "waiting" : null,
    position: index >= 0 ? index + 1 : null
  };
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function change(machines, owner, input, now) {
  const machine = machines.find(item => item.id === input.machine);
  if (!machine) throw new HttpError(404, "That washer does not exist in this hall.");
  const { action, duration } = input;
  const existing = machines.find(item => item.active?.owner === owner || item.hold?.owner === owner || item.line.includes(owner));
  const state = publicMachine(machine, owner);
  switch (action) {
    case "join":
      if (state.mine === "waiting" || state.mine === "held") return;
      if (existing) throw new HttpError(409, "Finish or release your current turn in this hall first.");
      if (state.state === "free") {
        machine.hold = { owner, end: now + HOLD_SECS };
        return;
      }
      if (machine.line.length >= 12) throw new HttpError(409, "This line is full. Try another washer.");
      machine.line.push(owner);
      return;
    case "start":
      if (!CYCLE_MINS.includes(duration)) throw new HttpError(400, "Choose one of the available cycle lengths.");
      if (state.mine === "running") return;
      if (existing && state.mine !== "held") throw new HttpError(409, "Finish or release your current turn in this hall first.");
      if (state.state !== "free" && state.mine !== "held") throw new HttpError(409, "This washer is already in use or reserved.");
      machine.hold = null;
      machine.active = { owner, end: now + duration * 60 };
      return;
    case "leave":
      if (state.mine === "waiting") machine.line = machine.line.filter(person => person !== owner);
      if (state.mine === "held") promote(machine, now);
      if (state.mine === "running") throw new HttpError(409, "End your cycle to release this washer.");
      return;
    case "finish":
      if (state.mine !== "running") throw new HttpError(409, "Only the current washer user can end this cycle.");
      machine.active = null;
      promote(machine, now);
      return;
    default:
      throw new HttpError(400, "Choose a valid washer action.");
  }
}
