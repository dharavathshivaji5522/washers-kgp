"use strict";

const $ = selector => document.querySelector(selector);
const icon = name => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const tones = ["violet", "mint", "peach"];
const initial = new URLSearchParams(location.search);
const newRoom = () => crypto.randomUUID().replaceAll("-", "").slice(0, 16);
let room = /^[a-f0-9]{16}$/.test(initial.get("room")) ? initial.get("room") : initial.get("demo") === "1" ? newRoom() : "campus";
let hall = HALLS.find(item => item.id === (initial.get("hall") || localStorage.getItem("washroom-hall"))) || HALLS[0];
let quickMachine = /^\d+$/.test(initial.get("machine")) ? Number(initial.get("machine")) : null;
let board = null;
let filter = "all";
let connected = false;
let inFlight = false;
let revision = 0;
let boardSignature = "";
let clockOffset = 0;
let toastTimer;
let previouslyHeld = null;

const statusText = { free: "Available", running: "In use", held: "Reserved" };
const actionText = { start: "Start wash", join: "Join queue", leave: "Leave queue", finish: "End cycle" };
const hallLabel = item => item.id.startsWith("vsrc") ? item.name : `${item.name} Hall`;
const washerLabel = id => `Washer ${String(id).padStart(2, "0")}`;

function boardURL(machine) {
  const url = new URL(location.origin);
  url.searchParams.set("hall", hall.id);
  if (room !== "campus") url.searchParams.set("room", room);
  if (machine) url.searchParams.set("machine", machine);
  return url;
}

function notice(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 4800);
}

function setConnectivity(state) {
  connected = state === "live";
  $("#sync").dataset.state = state;
  $("#sync-text").textContent = { live: "Live board", loading: "Connecting", offline: "Reconnecting" }[state];
}

function remaining(end) {
  const time = Math.max(0, end - Math.floor((Date.now() + clockOffset) / 1000));
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
  if (machine.mine === "running") return ["finish", "End cycle"];
  if (machine.mine === "held") return ["start", "Check in"];
  if (machine.mine === "waiting") return ["leave", "Leave queue"];
  if (machine.state === "free") return ["start", "Start wash"];
  return ["join", "Join queue"];
}

function actionButton(machine, action, label, style = "primary") {
  const hasTurn = board?.machines.some(item => item.mine);
  const disabled = !connected || inFlight || (!machine.mine && hasTurn);
  return `<button class="button ${style} full" type="button" data-operation="${action}" data-machine="${machine.id}" ${disabled ? "disabled" : ""}>${label}</button>`;
}

function machineCard(machine) {
  const { id, state, end, waiting, mine } = machine;
  const tone = tones[(id - 1) % tones.length];
  const [action, label] = nextAction(machine);
  const time = end ? `<span data-until="${end}">${remaining(end)}</span> ${state === "held" ? "to check in" : "left"}` : "Ready to use";
  return `<article class="card" id="washer-${id}">
    <figure class="${tone}">${illustration(tone)}
      <figcaption><button type="button" class="icon-button" data-qr="${id}" aria-label="QR code for ${washerLabel(id)}" title="Washer QR code">${icon("qr")}</button></figcaption>
    </figure>
    <div class="card-top"><h3>${washerLabel(id)}</h3><span class="pill ${state}"><span class="dot"></span>${statusText[state]}</span></div>
    <p class="card-meta">${icon("clock")}<span>${time}</span></p>
    <p class="card-meta">${icon("users")}<span>${waiting ? `${waiting} waiting` : "No one in line"}</span></p>
    <div class="card-actions">${actionButton(machine, action, label, action === "leave" || action === "finish" ? "secondary" : "primary")}</div>
  </article>`;
}

function turnPanel() {
  const current = board?.machines.find(machine => machine.mine);
  if (!current) return `<div class="turn-empty"><strong>No active turn</strong><p>Your countdown and place in line will appear here.</p></div>`;
  const time = `<span data-until="${current.end}">${remaining(current.end)}</span>`;
  const details = {
    waiting: [`#${current.position} in line`, current.position === 1 ? "You’re next after the current turn." : `${current.position - 1} ahead of you in the queue.`],
    held: ["It’s your turn", `Check in within ${time} to keep this washer.`],
    running: ["Your wash is running", `${time} left in your cycle.`]
  };
  const [title, description] = details[current.mine];
  const [action, label] = nextAction(current);
  return `<div class="turn-detail"><strong>${title} · ${washerLabel(current.id)}</strong><p>${description}</p>
    ${actionButton(current, action, label, current.mine === "held" ? "primary" : "secondary")}
    ${current.mine === "held" ? actionButton(current, "leave", "Release turn", "secondary") : ""}</div>`;
}

function render() {
  const machineCount = board?.machines.length ?? "–";
  const freeCount = board?.machines.filter(item => item.state === "free").length ?? "–";
  $("#total-count").textContent = machineCount;
  $("#free-count").textContent = freeCount;
  $("#art-status").textContent = board ? `${freeCount} ${freeCount === 1 ? "washer" : "washers"} available` : "Washer board";
  $(".art-note").classList.toggle("unavailable", !board || freeCount === 0);
  $("#busy-count").textContent = board ? machineCount - freeCount : "–";
  const signature = JSON.stringify([hall.id, room, filter, $("#sync").dataset.state, inFlight, board?.machines]);
  if (signature === boardSignature) return;
  boardSignature = signature;
  const active = document.activeElement;
  const focusOperation = active?.dataset.operation;
  const focusMachine = active?.dataset.machine;
  const focusQR = active?.dataset.qr;
  if (!board) {
    $("#machine-cards").innerHTML = `<p class="loading">${connected ? "Loading washers…" : $("#sync").dataset.state === "offline" ? "Couldn’t load the board. Reconnecting automatically…" : "Loading washers…"}</p>`;
  } else {
    const visible = board.machines.filter(machine => filter === "all" || (filter === "free" ? machine.state === "free" : machine.state !== "free"));
    $("#machine-cards").innerHTML = visible.length ? visible.map(machineCard).join("") : `<p class="empty-list">${filter === "free" ? "All washers are busy. Open the Busy tab to join a queue." : "No busy washers in this hall right now."}</p>`;
  }
  $("#turn-content").innerHTML = turnPanel();
  if (focusOperation && focusMachine) {
    const section = active.closest(".sidebar") ? ".sidebar" : ".cards";
    const selector = `${section} [data-machine="${focusMachine}"][data-operation="${focusOperation}"]`;
    ($(selector) || $(`${section} [data-machine="${focusMachine}"]`))?.focus({ preventScroll: true });
  }
  if (focusQR) $(`[data-qr="${focusQR}"]`)?.focus({ preventScroll: true });
}

function acceptBoard(data) {
  board = data;
  clockOffset = data.now * 1000 - Date.now();
  setConnectivity("live");
  const held = data.machines.find(item => item.mine === "held");
  if (held && previouslyHeld !== held.id) notice(`It’s your turn on ${washerLabel(held.id)}.`);
  previouslyHeld = held?.id ?? null;
  document.title = held ? "Your turn · Washroom" : "Washroom · KGP Hall Laundry";
  render();
  if (quickMachine) {
    const machine = data.machines.find(item => item.id === quickMachine);
    quickMachine = null;
    if (machine) {
      const [action] = nextAction(machine);
      openAction(machine.id, action);
    } else notice("That washer is unavailable in the selected hall.");
  }
}

async function sync() {
  if (inFlight) return;
  const token = ++revision;
  const url = boardURL();
  url.pathname = "/api/board";
  try {
    const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(4500) });
    if (!response.ok) throw new Error("Could not reach the board");
    const data = await response.json();
    if (token === revision) acceptBoard(data);
  } catch {
    if (token === revision) {
      setConnectivity("offline");
      render();
    }
  }
}

function switchBoard(nextHall, nextRoom = room) {
  if (inFlight) return;
  hall = nextHall;
  room = nextRoom;
  localStorage.setItem("washroom-hall", hall.id);
  history.replaceState(null, "", boardURL());
  $("#current-hall").textContent = hall.name;
  $("#board-subtitle").textContent = hallLabel(hall);
  $("#demo-banner").hidden = room === "campus";
  $("#demo-button span").textContent = room === "campus" ? "Try demo" : "New demo";
  filter = "all";
  for (const button of document.querySelectorAll("[data-filter]")) {
    button.setAttribute("aria-pressed", String(button.dataset.filter === filter));
  }
  board = null;
  previouslyHeld = null;
  setConnectivity("loading");
  render();
  sync();
}

function hallOptions() {
  const query = $("#hall-search").value.trim().toLowerCase();
  const options = HALLS.filter(item => `${item.code} ${item.name} ${item.aliases || ""}`.toLowerCase().includes(query));
  $("#hall-options").innerHTML = options.length ? options.map(item => `<button class="hall-option" type="button" data-hall="${item.id}" aria-current="${item.id === hall.id}"><span class="hall-code">${item.code}</span>${hallLabel(item)}${item.id === hall.id ? icon("check") : ""}</button>`).join("") : "<p>No halls match your search.</p>";
}

function openAction(id, action) {
  const machine = board?.machines.find(item => item.id === id);
  if (!machine || !connected || inFlight) return;
  const hasOtherTurn = board.machines.some(item => item.mine && item.id !== id);
  if (hasOtherTurn) {
    notice("Finish or release your current turn in this hall first.");
    return;
  }
  const description = {
    start: "Choose a cycle length and start the washer when you’re beside it.",
    join: "You’ll move to the front as earlier turns finish. You’ll have five minutes to check in once this washer is reserved for you.",
    leave: machine.mine === "held" ? "Release this washer so the next person can check in." : "Leave this line and give up your current place.",
    finish: "End your timer and release the washer for the next person."
  };
  const cycle = action === "start" ? `<div class="cycle-options" role="group" aria-label="Cycle duration">${CYCLE_MINS.map(min => `<label class="cycle-option"><input type="radio" name="duration" value="${min}" ${min === 30 ? "checked" : ""}><span>${min} min</span></label>`).join("")}</div>` : "";
  const label = action === "leave" && machine.mine === "held" ? "Release turn" : actionText[action];
  $("#action-content").innerHTML = `<h2>${label} · ${washerLabel(id)}</h2><p>${description[action]}</p>
    <form id="washer-action">${cycle}<p id="action-error" class="action-error" role="alert" hidden></p><button type="submit" class="button primary full">${label}</button></form>`;
  const dialog = $("#action-dialog");
  dialog.showModal();
  $("#washer-action").addEventListener("submit", async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const duration = Number(new FormData(form).get("duration"));
    await perform({ action, machine: id, duration }, form);
  });
}

async function perform(input, form) {
  if (inFlight) return;
  inFlight = true;
  ++revision;
  const button = form.querySelector("button[type=submit]");
  button.disabled = true;
  const errorText = $("#action-error");
  errorText.hidden = true;
  render();
  try {
    const url = boardURL();
    url.pathname = "/api/board";
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(8000)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    $("#action-dialog").close();
    acceptBoard(result);
    const current = result.machines.find(item => item.id === input.machine);
    const success = {
      start: "Wash started.",
      join: current.mine === "held" ? "Washer held for five minutes." : `You’re #${current.position} in line.`,
      leave: "Turn released.",
      finish: "Cycle ended."
    };
    notice(success[input.action]);
  } catch (error) {
    errorText.textContent = error.message || "Couldn’t save. Please try again.";
    errorText.hidden = false;
  } finally {
    inFlight = false;
    button.disabled = false;
    render();
    sync();
  }
}

function share(machine) {
  const url = boardURL(machine).href;
  $("#share-title").textContent = machine ? `${washerLabel(machine)} QR` : "Share board";
  $("#share-description").textContent = machine ? "Scan with your phone to open this washer on the hall board." : "Open this hall’s board on another phone or share it with a hallmate.";
  $("#share-link").value = url;
  const code = qrcode(0, "M");
  code.addData(url);
  code.make();
  const image = new Image();
  image.src = code.createDataURL(4, 16);
  image.alt = machine ? `QR code for ${washerLabel(machine)}` : "QR code for this hall’s board";
  $("#share-qr").replaceChildren(image);
  $("#share-dialog").showModal();
}

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
  for (const button of document.querySelectorAll("[data-filter]")) {
    button.setAttribute("aria-pressed", String(button === choice));
  }
  render();
});
$(".workspace").addEventListener("click", event => {
  const target = event.target.closest("[data-operation], [data-qr]");
  if (!target) return;
  if (target.dataset.qr) share(Number(target.dataset.qr));
  else openAction(Number(target.dataset.machine), target.dataset.operation);
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
switchBoard(hall);
setInterval(() => { if (!document.hidden) sync(); }, 5000);
setInterval(updateTimers, 1000);
