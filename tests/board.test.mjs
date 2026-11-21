import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import worker from "../dist/server/index.js";

const deviceKey = "fixture_only_not_a_real_device_secret_012345678";
const labelKey = "fixture_qr_label_012345678";
function setup(pilot = false) {
  const db = new DatabaseSync(":memory:");
  for (const file of ["0000_laundry.sql", "0001_push.sql"]) db.exec(readFileSync(`drizzle/${file}`, "utf8"));
  const env = { DB: { prepare(sql) {
    return { bind(...values) {
      const statement = db.prepare(sql);
      return {
        async first() { return statement.get(...values); },
        async all() { return { results: statement.all(...values) }; },
        async run() { return { meta: statement.run(...values) }; }
      };
    } };
  } } };
  if (pilot) {
    env.PILOT_DEVICES = JSON.stringify({ "lbs/1": { deviceKey, labelKey } });
    env.PILOT_STAFF = JSON.stringify({ "staff@iitkgp.ac.in": ["lbs"] });
  }
  return ({ name, staff = false } = {}) => {
    let cookie = "";
    return async ({ path = "board", hall = "lbs", room, method, action, machine = 1,
      duration = 30, label = "demo-v2", pin, origin = "https://test.example", authorization, event, command } = {}) => {
      const url = new URL(`https://test.example/api/${path}?hall=${hall}&washer=${machine}`);
      if (room) url.searchParams.set("room", room);
      const headers = { cookie, origin };
      if (authorization) headers.authorization = authorization;
      if (name) {
        headers["oai-authenticated-user-id"] = name;
        headers["oai-authenticated-user-email"] = staff ? "staff@iitkgp.ac.in" : `${name}@kgpian.iitkgp.ac.in`;
        headers["oai-authenticated-user-full-name"] = `${name} Test`;
      }
      const verb = method || (action || event ? "POST" : "GET");
      const response = await worker.fetch(new Request(url, {
        method: verb, headers,
        ...(verb === "POST" ? { body: JSON.stringify({ event, command, action, machine, duration, label, pin }) } : {})
      }), env);
      cookie ||= response.headers.get("set-cookie")?.split(";")[0] || "";
      const body = await response.json();
      return { status: response.status, body, first: body.machines?.[0] };
    };
  };
}

async function signIn(...clients) {
  await Promise.all(clients.map(client => client({ path: "profile", method: "POST" })));
}

test("demo gates QR actions behind a resident identity and valid label", async () => {
  const a = setup()();
  assert.equal((await a({ action: "start" })).status, 401);
  await signIn(a);
  assert.equal((await a({ action: "start", label: "other-washer" })).status, 403);
  assert.equal((await a({ action: "start", origin: "https://unrelated.example" })).status, 403);
  assert.equal((await a({ action: "start", duration: 5 })).status, 400);
  assert.equal((await a({ action: "start" })).first.state, "running");
});

test("clothes inside block handoff; only next resident can send a rate-limited private reminder", async () => {
  const client = setup();
  const [a, b, c, anonymous] = [client(), client(), client(), client()];
  await signIn(a, b, c);
  await a({ action: "start" });
  await b({ action: "join" });
  await c({ action: "join" });
  assert.equal((await b({ action: "join" })).first.waiting, 2);
  assert.equal((await a({ action: "complete" })).first.state, "unloading");
  assert.equal((await a({ path: "inbox" })).body.events[0].type, "complete");
  assert.equal((await b()).first.position, 1);
  assert.match((await b()).first.pickup.label, /Demo resident/);
  assert.equal((await c()).first.pickup, null);
  assert.equal((await anonymous()).first.pickup, null);
  assert.equal((await c({ action: "remind" })).status, 403);
  assert.equal((await b({ action: "report" })).status, 409);
  assert.equal((await b({ action: "remind" })).status, 200);
  assert.equal((await b({ action: "remind" })).status, 429);
  assert.ok((await a({ path: "inbox" })).body.events.some(event => event.type === "reminder"));
  assert.equal((await c({ path: "inbox" })).body.events.length, 0);
  assert.equal((await b({ action: "start" })).status, 409);
  assert.equal((await a({ action: "collect" })).first.state, "held");
  assert.equal((await b()).first.mine, "held");
  assert.equal((await b({ path: "inbox" })).body.events[0].type, "turn");
  await b({ action: "leave" });
  assert.equal((await c({ action: "start" })).first.mine, "running");
});

test("concurrent starts cannot claim the same washer twice", async () => {
  const client = setup();
  const a = client(), b = client();
  await signIn(a, b);
  const results = await Promise.all([a({ action: "start" }), b({ action: "start" })]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
});

test("room and hall state are independently scoped", async () => {
  const a = setup()();
  await signIn(a);
  await a({ action: "start" });
  assert.equal((await a({ hall: "rk" })).first.state, "free");
  const demo = await a({ room: "1122334455667788" });
  assert.equal(demo.first.state, "free");
  assert.equal(demo.body.machines[1].state, "running");
  assert.equal((await a()).first.mine, "running");
});

test("pilot controller is authenticated, starts only with label plus on-site PIN, and confirms pickup separately", async () => {
  const client = setup(true);
  const resident = client({ name: "Asha" });
  const second = client({ name: "Neel" });
  const device = client();
  const controller = input => device({ path: "controller", authorization: `Bearer ${deviceKey}`, ...input });
  assert.equal((await resident()).first.state, "offline");
  assert.equal((await device({ path: "controller", event: "ready" })).status, 401);
  assert.equal((await controller({ event: "heartbeat" })).body.command, null);
  assert.equal((await resident()).first.state, "offline");
  await controller({ event: "ready" });
  assert.equal((await resident()).first.state, "free");
  assert.equal((await device({ action: "start" })).status, 401);
  await controller({ event: "presence", pin: "123456" });
  for (let attempt = 0; attempt < 5; attempt++) assert.equal((await resident({ action: "start", label: labelKey, pin: "111111" })).status, 403);
  assert.equal((await resident({ action: "start", label: labelKey, pin: "123456" })).status, 429);
  await controller({ event: "presence", pin: "123456" });
  assert.equal((await resident({ action: "start", label: labelKey, pin: "123456" })).first.state, "starting");
  const command = (await controller({ event: "heartbeat" })).body.command.id;
  assert.equal((await controller({ event: "started", command: "stale" })).status, 409);
  await controller({ event: "started", command });
  assert.equal((await second({ action: "join" })).first.position, 1);
  assert.equal((await resident({ action: "complete" })).status, 409);
  await controller({ event: "complete", command });
  assert.equal((await second()).first.state, "unloading");
  assert.equal((await second()).first.pickup.label, "Asha T.");
  assert.equal((await resident({ action: "collect" })).status, 409);
  assert.equal((await controller({ event: "clear", command })).status, 200);
  assert.equal((await controller({ event: "clear", command })).status, 200);
  assert.equal((await second()).first.mine, "held");
  assert.equal((await second({ action: "start", label: labelKey, pin: "123456" })).status, 403);
});

test("demo time advances collection without advancing the queue and expires missed holds FIFO", () => {
  const code = readFileSync("src/catalog.js", "utf8") + readFileSync("src/model.js", "utf8") + "; ({ normalize, deviceCommand })";
  const { normalize, deviceCommand } = runInNewContext(code, { crypto });
  const machine = { id: 1, active: { owner: "a", phase: "running", end: 100 }, hold: null, line: [{ owner: "b" }, { owner: "c" }] };
  const board = { machines: [machine], events: [] };
  normalize(board, 110, true);
  assert.equal(machine.active.phase, "unloading");
  assert.equal(machine.line.length, 2);
  assert.equal(board.events[0].type, "complete");
  machine.active = null;
  machine.hold = { owner: "b", end: 400 };
  normalize(board, 400, true);
  assert.equal(machine.hold.owner, "b");
  normalize(board, 1000, true);
  assert.equal(machine.hold, null);
  const stale = { active: { phase: "starting", command: "old", issued: 100 }, device: { status: "ready" } };
  assert.equal(deviceCommand(stale, 131), null);
});

test("Web Push body decrypts with recipient key and RFC 8291 context", async () => {
  const code = readFileSync("src/push.js", "utf8") + "; ({ encryptPush, base64url, derive, utf8, concat })";
  const { encryptPush, base64url, derive, utf8, concat } = runInNewContext(code, { crypto, btoa, atob, TextEncoder, URL });
  const client = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const rawClient = new Uint8Array(await crypto.subtle.exportKey("raw", client.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const record = await encryptPush({ p256dh: base64url(rawClient), auth: base64url(auth) }, "Washroom check");
  const serverKey = record.slice(21, 21 + record[20]);
  const sender = await crypto.subtle.importKey("raw", serverKey, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: sender }, client.privateKey, 256);
  const ikm = await derive(shared, auth, concat(utf8("WebPush: info\0"), rawClient, serverKey), 32);
  const contentKey = await derive(ikm, record.slice(0, 16), utf8("Content-Encoding: aes128gcm\0"), 16);
  const iv = await derive(ikm, record.slice(0, 16), utf8("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", contentKey, "AES-GCM", false, ["decrypt"]);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, record.slice(21 + record[20])));
  assert.equal(plain.at(-1), 2);
  assert.equal(new TextDecoder().decode(plain.slice(0, -1)), "Washroom check");
});
