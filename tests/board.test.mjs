import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import worker from "../dist/server/index.js";

function setup() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync("drizzle/0000_laundry.sql", "utf8"));
  const env = { DB: { prepare(sql) {
    return { bind(...values) {
      const statement = db.prepare(sql);
      return {
        async first() { return statement.get(...values); },
        async run() { return { meta: statement.run(...values) }; }
      };
    } };
  } } };
  return (cookie = "") => async ({ hall = "lbs", room = "campus", action, machine = 1, duration = 30, origin = "https://test.example" } = {}) => {
    const url = `https://test.example/api/board?hall=${hall}&room=${room}`;
    const response = await worker.fetch(new Request(url, {
      headers: { cookie, origin },
      ...(action ? { method: "POST", body: JSON.stringify({ action, machine, duration }) } : {})
    }), env);
    cookie ||= response.headers.get("set-cookie")?.split(";")[0] || "";
    const body = await response.json();
    return { status: response.status, body, first: body.machines?.[0] };
  };
}

test("three sessions retain FIFO over finish, release, and check-in", async () => {
  const client = setup();
  const a = client(), b = client(), c = client();
  await Promise.all([a(), b(), c()]);
  assert.equal((await a({ action: "start" })).first.state, "running");
  assert.equal((await b({ action: "join" })).first.position, 1);
  assert.equal((await b({ action: "join" })).first.waiting, 1);
  assert.equal((await c({ action: "join" })).first.position, 2);
  assert.equal((await b({ action: "start", machine: 3 })).status, 409);
  assert.equal((await b({ action: "finish" })).status, 409);
  assert.equal((await a({ action: "finish" })).first.state, "held");
  assert.equal((await b()).first.mine, "held");
  assert.equal((await b({ action: "leave" })).first.mine, null);
  assert.equal((await c()).first.mine, "held");
  assert.equal((await c({ action: "start", duration: 40 })).first.mine, "running");
});

test("concurrent starts cannot claim the same washer twice", async () => {
  const client = setup();
  const a = client(), b = client();
  await Promise.all([a(), b()]);
  const results = await Promise.all([a({ action: "start" }), b({ action: "start" })]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
});

test("hall and demo room state stay independent", async () => {
  const a = setup()();
  await a();
  await a({ action: "start" });
  assert.equal((await a({ hall: "rk" })).first.state, "free");
  const demo = await a({ room: "1122334455667788" });
  assert.equal(demo.first.state, "free");
  assert.equal(demo.body.machines[1].state, "running");
  assert.equal((await a()).first.mine, "running");
});

test("invalid changes do not alter the board", async () => {
  const a = setup()();
  await a();
  assert.equal((await a({ action: "start", origin: "https://unrelated.example" })).status, 403);
  assert.equal((await a({ action: "start", duration: 1 })).status, 400);
  assert.equal((await a({ action: "start", machine: 9 })).status, 404);
  assert.equal((await a()).first.state, "free");
});

test("cycle expiry promotes FIFO and expired claims advance exactly once", () => {
  const code = readFileSync("src/catalog.js", "utf8") + readFileSync("src/model.js", "utf8") + "; normalize";
  const normalize = runInNewContext(code);
  const machines = [{ active: { owner: "a", end: 100 }, hold: null, line: ["b", "c"] }];
  normalize(machines, 100);
  assert.equal(machines[0].hold.owner, "b");
  assert.equal(machines[0].hold.end, 400);
  normalize(machines, 400);
  assert.equal(machines[0].hold.owner, "c");
  assert.equal(machines[0].hold.end, 700);
  normalize(machines, 700);
  assert.equal(machines[0].hold, null);
  assert.equal(machines[0].line.length, 0);
});
