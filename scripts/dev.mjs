import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, mkdirSync } from "node:fs";
import worker from "../dist/server/index.js";

mkdirSync(".local", { recursive: true });
const db = new DatabaseSync(process.env.WASHROOM_DB || ".local/washroom.sqlite");
if (!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'laundry_boards'").get()) {
  db.exec(readFileSync("drizzle/0000_laundry.sql", "utf8"));
}
const env = {
  DB: {
    prepare(query) {
      return {
        bind(...params) {
          const statement = db.prepare(query);
          return {
            async first() { return statement.get(...params) || null; },
            async run() { return { meta: statement.run(...params) }; }
          };
        }
      };
    }
  }
};

const port = Number(process.env.PORT) || 8787;
createServer(async (incoming, outgoing) => {
  try {
    const hasBody = incoming.method !== "GET" && incoming.method !== "HEAD";
    const request = new Request(`http://${incoming.headers.host}${incoming.url}`, {
      method: incoming.method,
      headers: incoming.headers,
      ...(hasBody ? { body: incoming, duplex: "half" } : {})
    });
    const response = await worker.fetch(request, env);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    console.error(error);
    outgoing.writeHead(500).end();
  }
}).listen(port, "127.0.0.1", () => console.log(`Local: http://127.0.0.1:${port}`));
