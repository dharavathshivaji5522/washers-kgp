"use strict";

const $ = selector => document.querySelector(selector);
const icon = name => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const escapeText = value => String(value).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
const tones = ["violet", "mint", "peach"];
const params = new URLSearchParams(location.search);
const newRoom = () => crypto.randomUUID().replaceAll("-", "").slice(0, 16);
const hallLabel = item => item.id.startsWith("vsrc") ? item.name : `${item.name} Hall`;
const washerLabel = id => `Washer ${String(id).padStart(2, "0")}`;
const statusText = { free: "Available", running: "In use", held: "Reserved", starting: "Starting", unloading: "Clothes inside", offline: "Offline" };
const notices = {
  turn: ["It’s your turn", "Scan the washer within five minutes."],
  complete: ["Your laundry is ready", "Collect your clothes to free the washer."],
  reminder: ["Pickup reminder", "The next resident is waiting for your washer."],
  report: ["Pickup reported", "A resident requested hall help with collection."],
  rejected: ["Washer start was declined", "The controller couldn’t start the cycle."]
};

let room = /^[a-f0-9]{16}$/.test(params.get("room")) ? params.get("room") : params.get("demo") === "1" ? newRoom() : "campus";
let hall = HALLS.find(item => item.id === (params.get("hall") || localStorage.getItem("washroom-hall"))) || HALLS[0];
let pendingMachine = /^\d+$/.test(params.get("machine")) ? Number(params.get("machine")) : null;
let pendingLabel = /^[A-Za-z0-9_-]{6,128}$/.test(params.get("label")) ? params.get("label") : null;
let board = null;
let resident = null;
let events = [];
let filter = "all";
let connected = false;
let inFlight = false;
let loading = false;
let operation = 0;
let signature = "";
let clockOffset = 0;
let toastTimer;
let inboxInitialized = false;
let pushRegistration = null;
let subscription = null;
let decoderPromise;
let scanner;

function boardURL(machine, label) {
  const url = new URL(location.origin);
  url.searchParams.set("hall", hall.id);
  if (room !== "campus") url.searchParams.set("room", room);
  if (machine) url.searchParams.set("machine", machine);
  if (label) url.searchParams.set("label", label);
  return url;
}

async function api(path, options = {}, url = boardURL()) {
  url.pathname = `/api/${path}`;
  const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(8500), ...options });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "The board couldn’t be updated.");
  return result;
}

function post(path, value = null, method = "POST") {
  return api(path, {
    method,
    ...(value && { headers: { "content-type": "application/json" }, body: JSON.stringify(value) })
  });
}

function notice(message) {
  clearTimeout(toastTimer);
  const toast = $("#toast");
  toast.textContent = message;
  toast.hidden = false;
  toastTimer = setTimeout(() => { toast.hidden = true; }, 5200);
}

function setConnectivity(state) {
  connected = state === "live";
  $("#sync").dataset.state = state;
  $("#sync-text").textContent = { live: "Live board", loading: "Connecting", offline: "Reconnecting" }[state];
}

function now() {
  return Math.floor((Date.now() + clockOffset) / 1000);
}

function remaining(end) {
  const time = Math.max(0, end - now());
  return `${Math.floor(time / 60)}:${String(time % 60).padStart(2, "0")}`;
}

function updateTimers() {
  for (const element of document.querySelectorAll("[data-until]")) {
    element.textContent = remaining(Number(element.dataset.until));
  }
}

function illustration(tone) {
  return `<div class="washer ${tone}" aria-hidden="true">
    <div class="washer-panel"><i></i><b></b><b></b><em></em></div>
    <div class="washer-door"><div class="washer-window"><i></i><b></b><em></em></div></div>
    <div class="washer-foot"></div>
  </div>`;
}

function nextAction(machine) {
  if (machine.state === "offline" && machine.mine !== "held" && machine.mine !== "waiting") return ["offline", "Unavailable"];
  if (machine.mine === "starting") return ["offline", "Waiting for washer"];
  if (machine.mine === "running") return board.demo ? ["complete", "Simulate completion"] : ["offline", "Cycle in progress"];
  if (machine.mine === "unloading") return board.demo ? ["collect", "I’ve collected my clothes"] : ["offline", "Waiting for pickup"];
  if (machine.mine === "held" && machine.state !== "offline") return ["use", "Use washer"];
  if (machine.mine === "held") return ["leave", "Release turn"];
  if (machine.mine === "waiting") return ["leave", "Leave queue"];
  if (machine.state === "free") return ["use", "Use washer"];
  return ["join", "Join queue"];
}

function actionButton(machine, action, label, style = "primary", locked = false) {
  const hasTurn = board?.machines.some(item => item.mine);
  const disabled = locked || action === "offline" || !connected || inFlight || (!machine.mine && hasTurn);
  return `<button class="button ${style} full" type="button" data-operation="${action}" data-machine="${machine.id}" ${disabled ? "disabled" : ""}>${label}</button>`;
}

function machineCard(machine) {
  const { id, state, end, waiting } = machine;
  const tone = tones[(id - 1) % tones.length];
  const [action, label] = nextAction(machine);
  const timed = `<span data-until="${end}">${remaining(end)}</span>`;
  const time = {
    free: "Ready to use", offline: "Controller unavailable", starting: "Awaiting controller",
    unloading: "Waiting for collection",
    held: end ? `${timed} to check in` : "Held for next resident",
    running: end > now() ? `${timed} estimated left` : "Checking completion"
  }[state];
  return `<article class="card" id="washer-${id}">
    <figure class="${tone}">${illustration(tone)}
      <figcaption><button type="button" class="icon-button" data-qr="${id}" aria-label="QR code for ${washerLabel(id)}" title="Washer QR code">${icon("qr")}</button></figcaption>
    </figure>
    <div class="card-top"><h3>${washerLabel(id)}</h3><span class="pill ${state}"><span class="dot"></span>${statusText[state]}</span></div>
    <p class="card-meta">${icon("clock")}<span>${time}</span></p>
    <p class="card-meta">${icon("users")}<span>${waiting ? `${waiting} waiting` : "No one in line"}</span></p>
    <div class="card-actions">${actionButton(machine, action, label, action === "use" || action === "join" ? "primary" : "secondary")}</div>
  </article>`;
}

function turnPanel() {
  const current = board?.machines.find(machine => machine.mine);
  if (!current) return `<div class="turn-empty"><strong>No active turn</strong><p>Your cycle and place in line will appear here.</p></div>`;
  const time = `<span data-until="${current.end}">${remaining(current.end)}</span>`;
  const details = {
    waiting: [`#${current.position} in line`, current.position === 1 ? "You’re next when the washer is empty." : `${current.position - 1} ahead in the queue.`],
    held: ["It’s your turn", `Scan your washer within ${time} to start.`],
    starting: ["Starting your wash", "Waiting for the controller to confirm."],
    running: ["Your wash is running", current.end > now() ? `${time} estimated left. We’ll alert you when it finishes.` : "Waiting for the controller to confirm completion."],
    unloading: ["Your wash is complete", "Collect your clothes to release this washer."]
  };
  let [title, description] = details[current.mine];
  if (current.state === "offline") description = "The controller is offline. The washer remains unavailable.";
  const [action, label] = nextAction(current);
  const pickup = current.pickup;
  const recent = pickup?.reminderAt && now() < pickup.reminderAt + (board.demo ? 20 : 120);
  const contact = pickup ? `<div class="pickup">
    <strong>Clothes still inside</strong>
    <p>${pickup.label ? `${escapeText(pickup.label)} was the previous washer user.` : "Waiting for the demo resident to collect their clothes."}</p>
    ${pickup.label ? actionButton(current, "remind", recent ? "Reminder sent" : "Send pickup reminder", "secondary", recent) : ""}
    ${pickup.reported ? `<p>${board.demo ? "Demo pickup report recorded." : "Pickup reported to hall staff."}</p>` : pickup.reportAt <= now() ? actionButton(current, "report", "Report overdue pickup", "secondary") : ""}
  </div>` : "";
  return `<div class="turn-detail"><strong>${title} · ${washerLabel(current.id)}</strong><p>${description}</p>
    ${contact}
    ${action !== "offline" ? actionButton(current, action, label, action === "use" ? "primary" : "secondary") : ""}
    ${current.mine === "held" && action !== "leave" ? actionButton(current, "leave", "Release turn", "secondary") : ""}</div>`;
}

function render() {
  const total = board?.machines.length ?? "–";
  const free = board?.machines.filter(item => item.state === "free").length ?? "–";
  $("#total-count").textContent = total;
  $("#free-count").textContent = free;
  $("#busy-count").textContent = board ? total - free : "–";
  $("#art-status").textContent = board ? `${free} ${free === 1 ? "washer" : "washers"} available` : "Washer board";
  $(".art-note").classList.toggle("unavailable", !board || free === 0);
  $("#demo-banner").hidden = !board?.demo;
  $("#exit-demo").hidden = room === "campus";
  $("#staff-panel").hidden = !resident?.staff?.length;
  const next = JSON.stringify([hall.id, room, filter, $("#sync").dataset.state, inFlight, board?.machines,
    board?.machines.map(machine => machine.pickup && [now() >= machine.pickup.reportAt, now() >= (machine.pickup.reminderAt || 0) + (board.demo ? 20 : 120)])]);
  if (next === signature) return;
  signature = next;
  const active = document.activeElement;
  if (!board) {
    const message = $("#sync").dataset.state === "offline" ? "Couldn’t load the board. Reconnecting automatically…" : "Loading washers…";
    $("#machine-cards").innerHTML = `<p class="loading">${message}</p>`;
  } else {
    const visible = board.machines.filter(machine => filter === "all" || (filter === "free" ? machine.state === "free" : machine.state !== "free"));
    $("#machine-cards").innerHTML = visible.length ? visible.map(machineCard).join("") : `<p class="empty-list">${filter === "free" ? "No washers are available right now." : "No busy washers in this hall right now."}</p>`;
  }
  $("#turn-content").innerHTML = turnPanel();
  if (active?.dataset.machine && active?.dataset.operation) {
    const area = active.closest(".sidebar") ? ".sidebar" : ".cards";
    $(`${area} [data-machine="${active.dataset.machine}"][data-operation="${active.dataset.operation}"]`)?.focus({ preventScroll: true });
  }
  if (active?.dataset.qr) $(`[data-qr="${active.dataset.qr}"]`)?.focus({ preventScroll: true });
}

function renderProfile() {
  $("#profile-label").textContent = resident?.name ? (resident.verified ? "Campus profile" : "Demo profile") : "Sign in";
  $("#profile-button").setAttribute("aria-label", resident?.name ? "Resident profile" : "Sign in");
  if (!$("#profile-dialog").open) return;
  const content = $("#profile-content");
  const title = resident?.name ? "Resident profile" : "Sign in to Washers";
  let body;
  if (resident?.name) {
    body = `<div class="profile-card"><strong>${escapeText(resident.name)}</strong>${resident.verified ? "Verified campus account" : "Demo identity · no campus data"}</div><p>Only the next resident in line can see your display name while waiting for pickup. Reminders stay in Washers.</p>`;
  } else if (resident?.demo) {
    body = '<p>Try the full queue, QR check-in, and pickup alerts with an anonymous demo account.</p><button id="demo-sign-in" class="button primary full" type="button">Continue as demo resident</button>';
  } else if (resident) {
    body = `<p>Use an IIT Kharagpur email account with the site’s sign-in provider.</p><a class="button primary full" href="${escapeText(resident.signIn)}" target="_top">Continue with campus email</a>`;
  } else {
    body = "<p>Connecting to resident sign-in…</p>";
  }
  content.innerHTML = `<div class="profile-symbol">${icon("user")}</div><h2>${title}</h2>${body}`;
  $("#demo-sign-in")?.addEventListener("click", async () => {
    try {
      await signInDemo();
      $("#profile-dialog").close();
      notice("Signed in as a demo resident.");
      sync();
    } catch (error) { notice(error.message); }
  });
}

async function signInDemo() {
  resident = await post("profile");
  renderProfile();
}

async function loadProfile() {
  const token = operation;
  try {
    const next = await api("profile");
    if (token !== operation) return;
    resident = next;
    renderProfile();
    render();
  } catch {}
}

function acceptBoard(data) {
  board = data;
  clockOffset = data.now * 1000 - Date.now();
  setConnectivity("live");
  document.title = data.machines.some(machine => machine.mine === "held") ? "Your turn · Washers" : "Washers · KGP Hall Laundry";
  render();
  if (pendingMachine) {
    const machine = data.machines.find(item => item.id === pendingMachine);
    const label = pendingLabel;
    pendingMachine = null;
    pendingLabel = null;
    if (machine) {
      const [action] = nextAction(machine);
      if (label && ["free", "held"].includes(machine.state) && (action === "use")) openUse(machine, label);
      else if (action !== "offline") openAction(machine.id, action);
    } else notice("That washer isn’t listed in this hall.");
  }
}

async function sync() {
  if (inFlight || loading) return;
  loading = true;
  const token = operation;
  try {
    const data = await api("board");
    if (token === operation) acceptBoard(data);
  } catch {
    if (token === operation) { setConnectivity("offline"); render(); }
  } finally {
    loading = false;
    if (token !== operation) sync();
  }
  if (token === operation) syncInbox();
}

function switchBoard(nextHall, nextRoom = room) {
  if (inFlight) return;
  operation++;
  hall = nextHall;
  room = nextRoom;
  localStorage.setItem("washroom-hall", hall.id);
  history.replaceState(null, "", boardURL());
  $("#current-hall").textContent = hall.name;
  $("#board-subtitle").textContent = hallLabel(hall);
  $("#demo-button span").textContent = room === "campus" ? "Try demo" : "New demo";
  filter = "all";
  events = [];
  inboxInitialized = false;
  updateBadge();
  for (const button of document.querySelectorAll("[data-filter]")) {
    button.setAttribute("aria-pressed", String(button.dataset.filter === filter));
  }
  board = null;
  resident = null;
  setConnectivity("loading");
  renderProfile();
  render();
  loadProfile().then(syncInbox);
  sync();
}

function hallOptions() {
  const query = $("#hall-search").value.trim().toLowerCase();
  const options = HALLS.filter(item => `${item.code} ${item.name} ${item.aliases || ""}`.toLowerCase().includes(query));
  $("#hall-options").innerHTML = options.length ? options.map(item => `<button class="hall-option" type="button" data-hall="${item.id}" aria-current="${item.id === hall.id}"><span class="hall-code">${item.code}</span>${hallLabel(item)}${item.id === hall.id ? icon("check") : ""}</button>`).join("") : "<p>No halls match your search.</p>";
}

function qrPicture(url, description) {
  const qr = qrcode(0, "M");
  qr.addData(url);
  qr.make();
  const image = new Image();
  image.src = qr.createDataURL(4, 16);
  image.alt = description;
  return image;
}

function showAction(html) {
  const dialog = $("#action-dialog");
  $("#action-content").innerHTML = html;
  if (!dialog.open) dialog.showModal();
}

function decoder() {
  if (typeof window.jsQR === "function") return Promise.resolve(window.jsQR);
  decoderPromise ||= new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "/qr-scan.js";
    script.addEventListener("load", () => resolve(window.jsQR), { once: true });
    script.addEventListener("error", () => reject(new Error("The QR reader couldn’t load.")), { once: true });
    document.head.append(script);
  }).catch(error => { decoderPromise = null; throw error; });
  return decoderPromise;
}

function stopCamera() {
  if (!scanner) return;
  cancelAnimationFrame(scanner.frame);
  scanner.stream?.getTracks().forEach(track => track.stop());
  scanner = null;
}

function scannedLabel(value, machine) {
  try {
    const link = new URL(value);
    const query = link.searchParams;
    const label = query.get("label");
    if (link.origin !== location.origin || link.pathname !== "/" || query.get("hall") !== hall.id ||
        query.get("machine") !== String(machine.id) || !/^[A-Za-z0-9_-]{6,128}$/.test(label) ||
        (query.get("room") || "campus") !== room || (board.demo && label !== "demo-v2")) return null;
    return label;
  } catch { return null; }
}

async function openCamera(machine) {
  stopCamera();
  showAction(`<h2>Scan ${washerLabel(machine.id)}</h2>
    <p>Point your camera at this washer’s QR label.</p>
    <video id="camera-view" class="camera-view" autoplay muted playsinline hidden></video>
    <p id="camera-status" role="status">Opening camera…</p>
    <button id="camera-back" class="button secondary full" type="button">Back</button>`);
  $("#camera-back").addEventListener("click", () => openUse(machine));
  const video = $("#camera-view");
  const message = $("#camera-status");
  const current = {};
  scanner = current;
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("Open this secure site on a phone with camera access.");
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
    if (scanner !== current) { stream.getTracks().forEach(track => track.stop()); return; }
    current.stream = stream;
    const decode = await decoder();
    if (scanner !== current) return;
    video.srcObject = stream;
    video.hidden = false;
    await video.play();
    if (scanner !== current) return;
    message.textContent = "Align the full QR code in the frame.";
    const canvas = document.createElement("canvas");
    const drawing = canvas.getContext("2d", { willReadFrequently: true });
    let last = 0;
    function read(time) {
      if (scanner !== current) return;
      if (time - last > 180 && video.readyState >= 2) {
        last = time;
        canvas.width = Math.min(640, video.videoWidth);
        canvas.height = Math.round(video.videoHeight * canvas.width / video.videoWidth);
        drawing.drawImage(video, 0, 0, canvas.width, canvas.height);
        const frame = drawing.getImageData(0, 0, canvas.width, canvas.height);
        const result = decode(frame.data, frame.width, frame.height);
        if (result) {
          const label = scannedLabel(result.data, machine);
          if (label) { openUse(machine, label); return; }
          message.textContent = "That QR is for a different washer. Scan the selected washer’s label.";
        }
      }
      current.frame = requestAnimationFrame(read);
    }
    current.frame = requestAnimationFrame(read);
  } catch {
    if (scanner !== current) return;
    stopCamera();
    message.textContent = "Camera access is unavailable. You can open the QR with your phone’s Camera app instead.";
  }
}

function openUse(machine, scanned = null) {
  stopCamera();
  const demo = board.demo;
  const label = scanned && (!demo || scanned === "demo-v2") ? scanned : null;
  if (demo && !label) {
    const url = boardURL(machine.id, "demo-v2");
    showAction(`<h2>Scan ${washerLabel(machine.id)}</h2>
      <p>Scan the QR with your phone to open this washer. The simulated controller starts after you confirm.</p>
      <div id="use-qr" class="share-qr scan-qr"></div>
      <button id="simulate-scan" class="button primary full" type="button">Simulate QR scan</button>
      <button id="scan-camera" class="button secondary full scan-secondary" type="button">Scan with camera</button>
      <p class="scan-footnote">In a hall, the QR is printed on the washer.</p>`);
    $("#use-qr").append(qrPicture(url.href, `Check-in QR for ${washerLabel(machine.id)}`));
    $("#simulate-scan").addEventListener("click", () => openUse(machine, "demo-v2"));
    $("#scan-camera").addEventListener("click", () => openCamera(machine));
    return;
  }
  if (!demo && !label) {
    showAction(`<h2>Scan ${washerLabel(machine.id)}</h2><div class="profile-symbol">${icon("qr")}</div><p>Scan the QR attached to this washer, then enter its six-digit code.</p>
      <button id="scan-camera" class="button primary full" type="button">Scan with camera</button>
      ${resident?.name ? "" : '<button id="open-profile" class="button secondary full scan-secondary" type="button">Resident sign-in</button>'}`);
    $("#scan-camera").addEventListener("click", () => openCamera(machine));
    $("#open-profile")?.addEventListener("click", () => { $("#action-dialog").close(); openProfile(); });
    return;
  }
  showAction(`<h2>Use ${washerLabel(machine.id)}</h2>
    <p>${demo ? "Demo QR linked. Select a cycle and confirm to start the simulated washer." : "Enter the displayed on-site code and confirm while beside the washer."}</p>
    <form id="washer-action">
      ${demo ? "" : '<label class="field-label">On-site code<input name="pin" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="off" required></label>'}
      <div class="cycle-options" role="group" aria-label="Cycle duration">${CYCLE_MINS.map(min => `<label class="cycle-option"><input type="radio" name="duration" value="${min}" ${min === 30 ? "checked" : ""}><span>${min} min</span></label>`).join("")}</div>
      <p id="action-error" class="action-error" role="alert" hidden></p>
      <button type="submit" class="button primary full">Use washer</button>
      ${demo ? '<p class="scan-footnote">Demo cycles run in seconds. A demo profile is created if you haven’t signed in.</p>' : ""}
    </form>`);
  $("#washer-action").addEventListener("submit", event => {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    perform({ action: "start", machine: machine.id, duration: Number(fields.get("duration")), label, pin: fields.get("pin") }, form);
  });
}

function openProfile() {
  if (!$("#profile-dialog").open) $("#profile-dialog").showModal();
  renderProfile();
}

function openAction(id, action) {
  const machine = board?.machines.find(item => item.id === id);
  if (!machine || !connected || inFlight) return;
  if (board.machines.some(item => item.mine && item.id !== id)) {
    notice("Finish or release your current turn in this hall first.");
    return;
  }
  if (action === "use") { openUse(machine); return; }
  const copy = {
    join: ["Join queue", "You have five minutes to scan the washer once it’s empty and reserved for you."],
    leave: [machine.mine === "held" ? "Release turn" : "Leave queue", "This gives up your current place for this washer."],
    complete: ["Simulate completion", "The controller reports that the cycle has ended. The washer stays occupied until the clothes are collected."],
    collect: ["Confirm collection", "The demo controller marks the drum empty and offers the washer to the next resident."],
    remind: ["Send pickup reminder", "The previous resident receives a private alert to collect their clothes."],
    report: ["Report overdue pickup", board.demo ? "Record a simulated overdue pickup report." : "Flag this washer for the hall staff assigned to your hall."]
  }[action];
  if (!copy) return;
  const [title, description] = copy;
  showAction(`<h2>${title} · ${washerLabel(id)}</h2><p>${description}</p><form id="washer-action">
    <p id="action-error" class="action-error" role="alert" hidden></p>
    <button type="submit" class="button primary full">${title}</button></form>`);
  $("#washer-action").addEventListener("submit", event => {
    event.preventDefault();
    perform({ action, machine: id }, event.currentTarget);
  });
}

async function perform(input, form) {
  if (inFlight) return;
  inFlight = true;
  operation++;
  const button = form.querySelector("button[type=submit]");
  const error = $("#action-error");
  button.disabled = true;
  error.hidden = true;
  render();
  try {
    if (!resident?.name) {
      if (!board.demo) {
        $("#action-dialog").close();
        openProfile();
        return;
      }
      await signInDemo();
    }
    const result = await post("board", input);
    $("#action-dialog").close();
    acceptBoard(result);
    const machine = result.machines.find(item => item.id === input.machine);
    const messages = {
      start: board.demo ? "Demo washer started." : "Start sent to the washer.",
      join: machine.mine === "held" ? "Washer held for five minutes." : `You’re #${machine.position} in line.`,
      leave: "Turn released.",
      complete: "Cycle complete. Collect your clothes.",
      collect: "Washer cleared.",
      remind: "Pickup reminder sent.",
      report: "Overdue pickup reported."
    };
    notice(messages[input.action]);
  } catch (failure) {
    error.textContent = failure.message;
    error.hidden = false;
  } finally {
    inFlight = false;
    button.disabled = false;
    render();
    sync();
    syncInbox();
  }
}

function share(machine) {
  const url = boardURL(machine, machine && board?.demo ? "demo-v2" : null).href;
  $("#share-title").textContent = machine ? `${washerLabel(machine)} QR` : "Share board";
  $("#share-description").textContent = machine ? "Scan to open this washer in the hall board." : "Open this hall’s board on another phone or share it with a hallmate.";
  $("#share-link").value = url;
  $("#share-qr").replaceChildren(qrPicture(url, machine ? `QR code for ${washerLabel(machine)}` : "QR code for this hall’s board"));
  $("#share-dialog").showModal();
}

const seenKey = () => `washroom-notices-${room}`;
function readNotices() {
  try { return JSON.parse(localStorage.getItem(seenKey()) || "[]"); } catch { return []; }
}
function updateBadge() {
  const seen = readNotices();
  const count = events.filter(item => !seen.includes(item.id)).length;
  $("#unread").hidden = !count;
  $("#unread").textContent = count > 9 ? "9+" : count;
  $("#inbox-button").setAttribute("aria-label", count ? `Notifications, ${count} unread` : "Notifications");
}

function displayInbox() {
  const content = $("#inbox-content");
  if (!events.length) {
    content.innerHTML = '<div class="turn-empty">No notifications yet.</div>';
    return;
  }
  content.innerHTML = events.map(item => {
    const [title, detail] = notices[item.type];
    const eventHall = HALLS.find(record => record.id === item.hall);
    const time = new Date(item.at * 1000);
    return `<article class="inbox-item"><strong>${title}</strong><p>${washerLabel(item.washer)} · ${eventHall?.code || ""}. ${detail}</p><time datetime="${time.toISOString()}">${escapeText(time.toLocaleString([], { dateStyle: "medium", timeStyle: "short" }))}</time></article>`;
  }).join("");
}

async function syncInbox() {
  if (!resident?.name && !$("#inbox-dialog").open) return;
  const token = operation;
  try {
    const result = await api("inbox");
    if (token !== operation) return;
    const prior = new Set(events.map(item => item.id));
    const next = result.events.find(item => !prior.has(item.id));
    if (inboxInitialized && next) notice(notices[next.type][0] + ".");
    events = result.events;
    inboxInitialized = true;
    if ($("#inbox-dialog").open) {
      displayInbox();
      localStorage.setItem(seenKey(), JSON.stringify(events.map(item => item.id)));
    }
    updateBadge();
  } catch {}
}

function pushSupported() {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

function updatePushButton() {
  const button = $("#push-button");
  button.querySelector("span").textContent = subscription ? "Turn off phone alerts" : "Enable phone alerts";
  button.disabled = !resident?.name || !resident?.pushKey || !pushSupported();
  $("#push-hint").textContent = !pushSupported() ? "In-app alerts are available. On iPhone, add Washers to your Home Screen to enable phone alerts." :
    !resident?.name ? "Sign in or start a demo wash to enable phone alerts." : "Cycle completion, pickup reminders, and your turn.";
}

async function openInbox() {
  $("#inbox-dialog").showModal();
  $("#push-feedback").hidden = true;
  displayInbox();
  localStorage.setItem(seenKey(), JSON.stringify(events.map(item => item.id)));
  updateBadge();
  updatePushButton();
  if (pushSupported()) {
    try {
      pushRegistration ||= await navigator.serviceWorker.register("/sw.js");
      subscription = await pushRegistration.pushManager.getSubscription();
      updatePushButton();
    } catch {}
  }
  syncInbox();
}

async function togglePush() {
  const feedback = $("#push-feedback");
  try {
    if (subscription) {
      await post("push", { endpoint: subscription.endpoint }, "DELETE");
      await subscription.unsubscribe();
      subscription = null;
      feedback.textContent = "Phone alerts are off. Your Washers inbox is still active.";
    } else {
      if (await Notification.requestPermission() !== "granted") throw new Error("Allow alerts in your browser settings to receive them on this phone.");
      pushRegistration ||= await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
      const encoding = resident.pushKey.replaceAll("-", "+").replaceAll("_", "/");
      const applicationServerKey = Uint8Array.from(atob(encoding), value => value.charCodeAt(0));
      const candidate = await pushRegistration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
      try { await post("push", candidate.toJSON()); } catch (error) { await candidate.unsubscribe(); throw error; }
      subscription = candidate;
      feedback.textContent = "Phone alerts are on for this browser.";
    }
  } catch (error) { feedback.textContent = error.message || "Phone alerts are unavailable in this browser."; }
  feedback.hidden = false;
  updatePushButton();
}

$("#action-dialog").addEventListener("close", stopCamera);
window.addEventListener("pagehide", stopCamera);
$("#hall-button").addEventListener("click", () => {
  if (inFlight) return;
  $("#hall-search").value = "";
  hallOptions();
  $("#hall-dialog").showModal();
  $("#hall-search").focus();
});
$("#hall-search").addEventListener("input", hallOptions);
$("#hall-options").addEventListener("click", event => {
  const option = event.target.closest("[data-hall]");
  if (!option) return;
  $("#hall-dialog").close();
  switchBoard(HALLS.find(item => item.id === option.dataset.hall));
});
$(".filters").addEventListener("click", event => {
  const choice = event.target.closest("[data-filter]");
  if (!choice) return;
  filter = choice.dataset.filter;
  for (const button of document.querySelectorAll("[data-filter]")) button.setAttribute("aria-pressed", String(button === choice));
  render();
});
$(".workspace").addEventListener("click", event => {
  const target = event.target.closest("[data-operation], [data-qr]");
  if (!target) return;
  if (target.dataset.qr) share(Number(target.dataset.qr));
  else openAction(Number(target.dataset.machine), target.dataset.operation);
});
$("#profile-button").addEventListener("click", openProfile);
$("#inbox-button").addEventListener("click", openInbox);
$("#push-button").addEventListener("click", togglePush);
$("#reports-button").addEventListener("click", async () => {
  try {
    const { reports } = await api("reports");
    showAction(`<h2>Pickup reports</h2><div class="inbox-content">${reports.length ? reports.map(report => `<article class="inbox-item"><strong>${escapeText(report.hall.toUpperCase())} · ${washerLabel(report.washer)}</strong><p>Overdue clothes from ${escapeText(report.resident)}.</p></article>`).join("") : "<p>No open pickup reports.</p>"}</div>`);
  } catch (error) { notice(error.message); }
});
$("#share-button").addEventListener("click", () => share());
$("#copy-link").addEventListener("click", async () => {
  const button = $("#copy-link span");
  try {
    await navigator.clipboard.writeText($("#share-link").value);
    button.textContent = "Link copied";
  } catch {
    $("#share-link").select();
    button.textContent = "Select and copy the link above";
  }
  setTimeout(() => { button.textContent = "Copy link"; }, 2400);
});
$("#demo-button").addEventListener("click", () => switchBoard(hall, newRoom()));
$("#exit-demo").addEventListener("click", () => switchBoard(hall, "campus"));
window.addEventListener("focus", sync);
document.addEventListener("visibilitychange", () => { if (!document.hidden) sync(); });
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").then(value => { pushRegistration = value; }).catch(() => {});
switchBoard(hall);
setInterval(() => { if (!document.hidden) sync(); }, 4000);
setInterval(updateTimers, 1000);
