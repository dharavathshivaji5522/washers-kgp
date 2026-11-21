const utf8 = value => new TextEncoder().encode(value);
const base64url = data => btoa(String.fromCharCode(...data)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
const bytes = value => Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), c => c.charCodeAt(0));
const concat = (...chunks) => {
  const joined = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  return joined;
};

const noticeText = {
  turn: ["It’s your turn", "You have five minutes to check in at the washer."],
  complete: ["Your laundry is ready", "Please collect your clothes so the next resident can use the washer."],
  reminder: ["Pickup reminder", "The next resident is waiting. Please collect your laundry."],
  report: ["Pickup reported", "A resident requested hall help. Please collect your laundry."],
  rejected: ["Washer start was declined", "The controller could not start this cycle. Check the washer or ask hall staff."]
};

function pushURL(input) {
  const url = new URL(input);
  const platforms = ["fcm.googleapis.com", "updates.push.services.mozilla.com", "web.push.apple.com"];
  if (url.protocol !== "https:" || url.username || url.password || url.port ||
      !(platforms.includes(url.hostname) || url.hostname.endsWith(".push.apple.com"))) throw new Error("Unsupported push service");
  return url;
}

function validateSubscription(input) {
  try {
    const { endpoint, keys } = input;
    if (typeof endpoint !== "string" || endpoint.length > 1300 || typeof keys.p256dh !== "string" ||
        typeof keys.auth !== "string" || keys.p256dh.length > 90 || keys.auth.length > 32 ||
        bytes(keys.p256dh).length !== 65 || bytes(keys.auth).length !== 16) throw new Error("Invalid subscription");
    pushURL(endpoint);
    return { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } };
  } catch {
    throw new HttpError(400, "The browser did not provide a supported push subscription.");
  }
}

async function derive(ikm, salt, info, length) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8));
}

async function encryptPush(keys, message) {
  const receiverKey = bytes(keys.p256dh);
  const client = await crypto.subtle.importKey("raw", receiverKey, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const sender = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const senderKey = new Uint8Array(await crypto.subtle.exportKey("raw", sender.publicKey));
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: client }, sender.privateKey, 256));
  const context = concat(utf8("WebPush: info\0"), receiverKey, senderKey);
  const ikm = await derive(ecdh, bytes(keys.auth), context, 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const aes = await derive(ikm, salt, utf8("Content-Encoding: aes128gcm\0"), 16);
  const iv = await derive(ikm, salt, utf8("Content-Encoding: nonce\0"), 12);
  const cipher = await crypto.subtle.importKey("raw", aes, "AES-GCM", false, ["encrypt"]);
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, cipher, concat(utf8(message), Uint8Array.of(2))));
  return concat(salt, Uint8Array.of(0, 0, 16, 0, senderKey.length), senderKey, data);
}

async function sendPush(env, subscription, payload) {
  const url = pushURL(subscription.endpoint);
  const signingKey = await crypto.subtle.importKey("jwk", JSON.parse(env.PUSH_PRIVATE), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const claims = {
    aud: url.origin, exp: seconds() + 7200, sub: env.PUSH_SUBJECT
  };
  const token = [base64url(utf8('{"typ":"JWT","alg":"ES256"}')), base64url(utf8(JSON.stringify(claims)))].join(".");
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, signingKey, utf8(token));
  const auth = `vapid t=${token}.${base64url(new Uint8Array(signature))}, k=${env.PUSH_PUBLIC}`;
  const body = await encryptPush(subscription.keys, JSON.stringify(payload));
  const response = await fetch(url, {
    method: "POST", redirect: "error", body, signal: AbortSignal.timeout(4500),
    headers: { "content-encoding": "aes128gcm", "content-type": "application/octet-stream", authorization: auth, ttl: "1800" }
  });
  if ([404, 410].includes(response.status)) {
    await env.DB.prepare("DELETE FROM laundry_push WHERE endpoint = ?").bind(subscription.endpoint).run();
  } else if (!response.ok) {
    console.warn("Push service unavailable", response.status);
  }
}

async function dispatchNotices(env, events, config) {
  if (!env.PUSH_PRIVATE || !env.PUSH_PUBLIC || !env.PUSH_SUBJECT || !events.length) return;
  await Promise.allSettled(events.map(async event => {
    const { results } = await env.DB.prepare("SELECT subscription FROM laundry_push WHERE owner = ? LIMIT 5")
      .bind(event.owner).all();
    const [title, message] = noticeText[event.type];
    const params = new URLSearchParams({ hall: config.hall.id });
    if (config.room !== "campus") params.set("room", config.room);
    await Promise.allSettled(results.map(row => sendPush(env, JSON.parse(row.subscription), {
      id: event.id, title, body: `Washer ${event.washer} · ${config.hall.code}. ${message}`, url: `/?${params}`
    })));
  }));
}
