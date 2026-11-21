const cache = { "cache-control": "no-store" };
const hardening = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
};

function json(value, status = 200, headers = {}) {
  return Response.json(value, { status, headers: { ...hardening, ...cache, ...headers } });
}

function settings(env, url) {
  const room = url.searchParams.get("room") || "campus";
  if (!/^(campus|[a-f0-9]{16})$/.test(room)) throw new HttpError(400, "Invalid room.");
  return {
    room,
    hall: HALLS.find(item => item.id === url.searchParams.get("hall")),
    demo: room !== "campus" || !env.PILOT_DEVICES,
    devices: room === "campus" && env.PILOT_DEVICES ? JSON.parse(env.PILOT_DEVICES) : {}
  };
}

function campusIdentity(request) {
  const id = request.headers.get("oai-authenticated-user-id");
  const email = request.headers.get("oai-authenticated-user-email")?.trim().toLowerCase();
  if (!id || !email || !CREDS_DOMAIN.test(email)) return null;
  const normalized = request.headers.get("oai-authenticated-user-full-name") || "";
  let name = normalized;
  if (request.headers.get("oai-authenticated-user-full-name-encoding") === "percent-encoded-utf-8") {
    try { name = decodeURIComponent(normalized); } catch { name = ""; }
  }
  const names = name.trim().split(/\s+/);
  const first = names[0]?.replace(/[^\p{L}\p{M}'-]/gu, "").slice(0, 28);
  const last = names.length > 1 ? names.at(-1).match(/\p{L}/u)?.[0] : "";
  return {
    id: `campus:${id}`, email, name: first ? `${first}${last ? ` ${last}.` : ""}` : "Campus resident",
    verified: true
  };
}

function identity(request, config) {
  if (!config.demo) return campusIdentity(request);
  const token = request.headers.get("cookie")?.match(/(?:^|;\s*)washer_resident=([a-f0-9]{32})(?:;|$)/)?.[1];
  return token ? { id: `demo:${token}`, name: `Demo resident ${token.slice(-4).toUpperCase()}`, verified: false } : null;
}

function profile(config, actor, env, url, headers = {}) {
  const params = new URLSearchParams({ hall: config.hall?.id || "lbs" });
  if (config.room !== "campus") params.set("room", config.room);
  const returnTo = url.pathname === "/api/profile" ? `/?${params}` : "/";
  const staff = !config.demo && actor?.email && env.PILOT_STAFF ? JSON.parse(env.PILOT_STAFF)[actor.email] : null;
  return json({
    demo: config.demo, name: actor?.name || null, verified: actor?.verified || false,
    pushKey: env.PUSH_PUBLIC || null,
    staff: Array.isArray(staff) ? staff : [],
    signIn: `/signin-with-chatgpt?return_to=${encodeURIComponent(returnTo)}`
  }, 200, headers);
}

async function readInput(request) {
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "Request body is required.");
  const data = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > 4096) {
      await reader.cancel();
      throw new HttpError(413, "The request is too large.");
    }
    data.push(value);
  }
  try {
    const input = JSON.parse(new TextDecoder().decode(concat(...data)));
    if (!input || typeof input !== "object") throw new Error("Invalid input");
    return input;
  } catch {
    throw new HttpError(400, "Invalid request.");
  }
}

const roomKey = config => config.demo ? config.room : "pilot";

function getStore(env, config) {
  const key = `v2/${roomKey(config)}/${config.hall.id}`;
  const read = () => env.DB.prepare("SELECT version, snapshot FROM laundry_boards WHERE board_key = ?").bind(key).first();
  async function load(now) {
    const found = await read();
    if (found) return found;
    const board = createBoard(config.hall, now, config.room !== "campus", !config.demo);
    await env.DB.prepare("INSERT OR IGNORE INTO laundry_boards (board_key, snapshot) VALUES (?, ?)")
      .bind(key, JSON.stringify(board)).run();
    return read();
  }
  async function changeBoard(ctx, apply, now) {
    let row = await load(now);
    for (let attempt = 0; attempt < 8; attempt++) {
      const board = JSON.parse(row.snapshot);
      const known = new Set(board.events.map(event => event.id));
      normalize(board, now, config.demo);
      const result = apply(board);
      const snapshot = JSON.stringify(board);
      if (snapshot === row.snapshot) return result;
      const saved = await env.DB.prepare("UPDATE laundry_boards SET snapshot = ?, version = version + 1 WHERE board_key = ? AND version = ?")
        .bind(snapshot, key, row.version).run();
      if (saved.meta.changes === 1) {
        const events = board.events.filter(event => !known.has(event.id));
        if (events.length && ctx?.waitUntil) ctx.waitUntil(dispatchNotices(env, events, config));
        return result;
      }
      row = await read();
    }
    throw new HttpError(503, "The board is busy. Please try again.");
  }
  return { changeBoard };
}

async function requestDevice(request, env, ctx, config, url, now) {
  if (config.demo || !config.hall) throw new HttpError(404, "Controller route is unavailable.");
  const machineId = Number(url.searchParams.get("washer"));
  const provisioned = config.devices[`${config.hall.id}/${machineId}`];
  const token = request.headers.get("authorization")?.match(/^Bearer ([A-Za-z0-9_-]{32,128})$/)?.[1];
  if (!provisioned?.deviceKey || !token || token.length !== provisioned.deviceKey.length ||
      ![...token].reduce((same, char, index) => same & Number(char === provisioned.deviceKey[index]), 1)) {
    throw new HttpError(401, "Controller authentication required.");
  }
  if (!Number.isInteger(machineId) || machineId < 1 || machineId > config.hall.count) throw new HttpError(404, "Unknown controller.");
  const input = await readInput(request);
  const command = await getStore(env, config).changeBoard(ctx, board => {
    updateDevice(board, machineId, input, now);
    return deviceCommand(board.machines.find(machine => machine.id === machineId), now);
  }, now);
  return json({ now, command });
}

async function routePush(request, env, actor) {
  if (!actor) throw new HttpError(401, "Sign in to enable notifications.");
  const input = await readInput(request);
  if (request.method === "DELETE") {
    if (typeof input.endpoint !== "string" || input.endpoint.length > 1300) throw new HttpError(400, "Unknown subscription.");
    await env.DB.prepare("DELETE FROM laundry_push WHERE endpoint = ? AND owner = ?").bind(input.endpoint, actor.id).run();
    return json({ enabled: false });
  }
  if (!env.PUSH_PUBLIC || !env.PUSH_PRIVATE) throw new HttpError(503, "Phone notifications are unavailable. Check your in-app inbox.");
  const subscription = validateSubscription(input);
  await env.DB.prepare("INSERT INTO laundry_push (endpoint, owner, subscription) VALUES (?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET owner = excluded.owner, subscription = excluded.subscription")
    .bind(subscription.endpoint, actor.id, JSON.stringify(subscription)).run();
  return json({ enabled: true });
}

async function inbox(env, config, actor, now) {
  if (!actor) return json({ events: [] });
  const { results } = await env.DB.prepare("SELECT board_key, snapshot FROM laundry_boards WHERE board_key LIKE ?")
    .bind(`v2/${roomKey(config)}/%`).all();
  const events = results.flatMap(row => JSON.parse(row.snapshot).events
    .filter(item => item.owner === actor.id && item.at >= now - 7 * 86400)
    .map(({ owner, ...item }) => ({ ...item, hall: row.board_key.split("/").at(-1) })));
  return json({ events: events.sort((a, b) => b.at - a.at).slice(0, 40) });
}

async function reports(env, config, actor) {
  const halls = !config.demo && actor?.email && env.PILOT_STAFF ? JSON.parse(env.PILOT_STAFF)[actor.email] : null;
  if (!Array.isArray(halls)) throw new HttpError(403, "Hall staff access is required.");
  const { results } = await env.DB.prepare("SELECT board_key, snapshot FROM laundry_boards WHERE board_key LIKE ?")
    .bind("v2/pilot/%").all();
  return json({ reports: results.flatMap(row => {
    const hall = row.board_key.split("/").at(-1);
    if (!halls.includes(hall)) return [];
    return JSON.parse(row.snapshot).machines
      .filter(machine => machine.active?.reported)
      .map(machine => ({ hall, washer: machine.id, resident: machine.active.label, at: machine.active.reported }));
  }) });
}

async function handleApi(request, env, ctx, url) {
  const method = request.method;
  if (!["GET", "POST", "DELETE"].includes(method)) return json({ error: "Method not allowed." }, 405);
  const config = settings(env, url);
  const now = seconds();
  if (url.pathname === "/api/controller" && method === "POST") return requestDevice(request, env, ctx, config, url, now);
  if (method !== "GET" && request.headers.get("origin") !== url.origin) throw new HttpError(403, "Open Washers to make changes.");
  const actor = identity(request, config);
  if (url.pathname === "/api/profile") {
    if (method === "GET") return profile(config, actor, env, url);
    if (!config.demo || method !== "POST") throw new HttpError(405, "Campus sign-in uses the verified provider.");
    if (actor) return profile(config, actor, env, url);
    const token = crypto.randomUUID().replaceAll("-", "");
    const secure = url.protocol === "https:" ? "; Secure" : "";
    const headers = { "set-cookie": `washer_resident=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure}` };
    return profile(config, { name: `Demo resident ${token.slice(-4).toUpperCase()}`, verified: false }, env, url, headers);
  }
  if (url.pathname === "/api/push" && ["POST", "DELETE"].includes(method)) return routePush(request, env, actor);
  if (url.pathname === "/api/inbox" && method === "GET") return inbox(env, config, actor, now);
  if (url.pathname === "/api/reports" && method === "GET") return reports(env, config, actor);
  if (url.pathname !== "/api/board" || !["GET", "POST"].includes(method)) throw new HttpError(404, "Page not found.");
  if (!config.hall) throw new HttpError(400, "Invalid hall.");
  if (method === "POST" && !actor) throw new HttpError(401, "Sign in before using a washer.");
  const input = method === "POST" ? await readInput(request) : null;
  const data = await getStore(env, config).changeBoard(ctx, board => {
    const denied = input && change(board, actor, input, now, config);
    if (denied) return denied;
    return {
      now, hall: config.hall.id, demo: config.demo,
      machines: board.machines.map(machine => publicMachine(machine, actor?.id, now, config.demo, !!config.devices[`${config.hall.id}/${machine.id}`]))
    };
  }, now);
  if (data instanceof HttpError) throw data;
  return json(data);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith("/api/")) return await handleApi(request, env, ctx, url);
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
