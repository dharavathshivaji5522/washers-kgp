import { randomInt } from "node:crypto";
import { createInterface } from "node:readline/promises";

const [base, hall, washer] = process.argv.slice(2);
const token = process.env.WASHROOM_CONTROLLER_TOKEN;
const label = process.env.WASHROOM_LABEL_KEY;
if (!base || !hall || !/^\d+$/.test(washer || "") || !token || !label) {
  console.error("Usage: WASHROOM_CONTROLLER_TOKEN=… WASHROOM_LABEL_KEY=… node scripts/controller-simulator.mjs <origin> <hall> <washer>");
  process.exit(1);
}
const endpoint = new URL("/api/controller", base);
endpoint.searchParams.set("hall", hall);
endpoint.searchParams.set("washer", washer);
const labelURL = new URL("/", base);
labelURL.search = new URLSearchParams({ hall, machine: washer, label });
console.log("Bench simulation only. Printed-label destination:", labelURL.href);

let active = null;
let phase = "idle";
let running = false;
const processed = new Set();
async function send(event, details = {}) {
  const response = await fetch(endpoint, {
    method: "POST", signal: AbortSignal.timeout(5000),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ event, ...details })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Controller API returned ${response.status}`);
  return data;
}

async function tick() {
  if (running) return;
  running = true;
  try {
    const { command, now } = await send("heartbeat");
    if (command && command.expiresAt >= now && !processed.has(command.id) && phase === "idle") {
      active = command.id;
      await send("started", { command: active });
      processed.add(active);
      phase = "running";
      console.log("Simulated cycle started. Type finish to complete, then clear to empty.");
    }
  } catch (error) {
    console.error("Controller heartbeat:", error.message);
  } finally { running = false; }
}
try { await send("ready"); } catch (error) { console.error(error.message); process.exit(1); }
const interval = setInterval(tick, 3500);
console.log("Type pin for an on-site code, finish to complete, clear to empty, or quit.");
const terminal = createInterface({ input: process.stdin, output: process.stdout });
for await (const value of terminal) {
  try {
    if (value === "quit") break;
    if (value === "pin" && phase === "idle") {
      const pin = String(randomInt(1_000_000)).padStart(6, "0");
      await send("presence", { pin });
      console.log("On-site code for the next 45 seconds:", pin);
    }
    if (value === "finish" && phase === "running") {
      await send("complete", { command: active });
      phase = "unloading";
      console.log("Cycle ended. Washer remains occupied.");
    }
    if (value === "clear" && phase === "unloading") {
      await send("clear", { command: active });
      phase = "idle";
      active = null;
      console.log("Washer is empty.");
    }
  } catch (error) { console.error(error.message); }
}
clearInterval(interval);
terminal.close();
