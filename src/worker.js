const cache = { "cache-control": "no-store" };
const hardening = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
};

function json(value, status = 200, headers = {}) {
  return Response.json(value, { status, headers: { ...hardening, ...cache, ...headers } });
}

function readOwner(request) {
  return request.headers.get("cookie")?.match(/(?:^|;\s*)washer_session=([a-f0-9]{32})(?:;|$)/)?.[1];
}

async function handleApi(request, env, url) {
  if (url.pathname !== "/api/board") return json({ error: "Page not found." }, 404);
  if (!["GET", "POST"].includes(request.method)) return json({ error: "Method not allowed." }, 405);
  if (request.method === "POST" && request.headers.get("origin") !== url.origin) {
    return json({ error: "Open your laundry board to make changes." }, 403);
  }
  const hall = HALLS.find(item => item.id === url.searchParams.get("hall"));
  const room = url.searchParams.get("room") || "campus";
  if (!hall || !/^(campus|[a-f0-9]{16})$/.test(room)) return json({ error: "Invalid hall or room." }, 400);
  const before = readOwner(request);
  const owner = before || crypto.randomUUID().replaceAll("-", "");
  const secure = url.protocol === "https:" ? "; Secure" : "";
  const headers = before ? {} : { "set-cookie": `washer_session=${owner}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure}` };
  const boardKey = `${room}/${hall.id}`;
  const now = seconds();

  const read = () => env.DB.prepare("SELECT version, snapshot FROM laundry_boards WHERE board_key = ?").bind(boardKey).first();
  let row = await read();
  if (!row) {
    const machines = createBoard(hall, now, room !== "campus");
    if (request.method === "GET") {
      await env.DB.prepare("INSERT OR IGNORE INTO laundry_boards (board_key, snapshot) VALUES (?, ?)").bind(boardKey, JSON.stringify(machines)).run();
      row = await read();
    } else {
      return json({ error: "Refresh the board before updating." }, 409, headers);
    }
  }

  const response = machines => json({ now, hall: hall.id, machines: machines.map(item => publicMachine(item, owner)) }, 200, headers);
  if (request.method === "GET") {
    const machines = JSON.parse(row.snapshot);
    normalize(machines, now);
    return response(machines);
  }

  if (!before) return json({ error: "Enable cookies and refresh the board." }, 409, headers);
  const reader = request.body?.getReader();
  if (!reader) return json({ error: "Select a washer action." }, 400);
  let input;
  try {
    const chunks = [];
    let length = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 1024) {
        await reader.cancel();
        return json({ error: "The request is too large." }, 413);
      }
      chunks.push(new TextDecoder().decode(value));
    }
    input = JSON.parse(chunks.join(""));
    if (!input || typeof input !== "object") throw new Error("Invalid input");
  } catch {
    return json({ error: "Select a valid washer action." }, 400);
  }

  for (let attempt = 0; attempt < 8; attempt++) {
    const machines = JSON.parse(row.snapshot);
    normalize(machines, now);
    change(machines, owner, input, now);
    const saved = await env.DB.prepare("UPDATE laundry_boards SET snapshot = ?, version = version + 1 WHERE board_key = ? AND version = ?")
      .bind(JSON.stringify(machines), boardKey, row.version).run();
    if (saved.meta.changes === 1) return response(machines);
    row = await read();
  }
  return json({ error: "The board is busy. Please try again." }, 503);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith("/api/")) return await handleApi(request, env, url);
      if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405 });
      const route = url.pathname === "/" ? "/index.html" : url.pathname;
      const asset = Object.hasOwn(ASSETS, route) ? ASSETS[route] : null;
      if (!asset) return new Response("Page not found", { status: 404, headers: hardening });
      return new Response(request.method === "HEAD" ? null : (asset.encoding === "base64" ? Uint8Array.from(atob(asset.data), char => char.charCodeAt(0)) : asset.data), {
        headers: { ...hardening, ...cache, "content-type": asset.type }
      });
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, error.status);
      console.error(error);
      return json({ error: "We couldn’t reach the laundry board. Try again in a moment." }, 503);
    }
  }
};
