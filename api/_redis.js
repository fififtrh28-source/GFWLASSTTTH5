const REST_URL =
  process.env.UPSTASH_REDIS_REST_URL ||
  process.env.KV_REST_API_URL ||
  "";

const REST_TOKEN =
  process.env.UPSTASH_REDIS_REST_TOKEN ||
  process.env.KV_REST_API_TOKEN ||
  "";

const localStore = new Map();

function now() {
  return Date.now();
}

function getLocal(key) {
  const entry = localStore.get(key);
  if (!entry) return null;
  if (entry.expiresAt && entry.expiresAt <= now()) {
    localStore.delete(key);
    return null;
  }
  return entry.value;
}

function setLocal(key, value, ttlSeconds) {
  localStore.set(key, {
    value,
    expiresAt: ttlSeconds > 0 ? now() + ttlSeconds * 1000 : 0,
  });
}

function normalizeUrl(url) {
  return url.replace(/\/+$/, "");
}

async function getCommand(commandName, ...args) {
  if (!REST_URL || !REST_TOKEN) return { configured: false, result: null };
  const encoded = [commandName, ...args].map((part) => encodeURIComponent(String(part))).join("/");

  const res = await fetch(`${normalizeUrl(REST_URL)}/${encoded}`, {
    headers: {
      Authorization: `Bearer ${REST_TOKEN}`,
    },
    signal: AbortSignal.timeout(3000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Redis ${commandName} failed: ${res.status} ${text.slice(0, 160)}`);
  }

  const json = await res.json();
  return { configured: true, result: json?.result ?? null };
}

async function pipeline(commands) {
  if (!REST_URL || !REST_TOKEN) return { configured: false, result: null };

  const res = await fetch(`${normalizeUrl(REST_URL)}/pipeline`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${REST_TOKEN}`,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(3000),
    body: JSON.stringify(commands),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Redis pipeline failed: ${res.status} ${text.slice(0, 160)}`);
  }

  const json = await res.json();
  return { configured: true, result: json?.result ?? null };
}

export function redisConfigured() {
  return Boolean(REST_URL && REST_TOKEN);
}

export async function cacheGet(key) {
  try {
    const { configured, result } = await getCommand("get", key);
    if (!configured) return getLocal(key);
    if (!result) return null;
    return JSON.parse(result);
  } catch (err) {
    console.warn(`[cache] Redis GET failed for ${key}:`, err?.message || err);
    return getLocal(key);
  }
}

export async function cacheSet(key, value, ttlSeconds) {
  setLocal(key, value, ttlSeconds);
  try {
    const serialized = JSON.stringify(value);
    const { configured } = await pipeline([["SET", key, serialized, "EX", String(ttlSeconds)]]);
    return configured;
  } catch (err) {
    console.warn(`[cache] Redis SET failed for ${key}:`, err?.message || err);
    return false;
  }
}

export async function incrementWithTtl(key, ttlSeconds) {
  const local = getLocal(key);
  const nextLocal = Number(local || 0) + 1;
  setLocal(key, nextLocal, ttlSeconds);

  try {
    const incr = await getCommand("incr", key);
    if (!incr.configured) return nextLocal;
    const count = Number(incr.result || 0);
    if (count === 1) await getCommand("expire", key, String(ttlSeconds));
    return count;
  } catch (err) {
    console.warn(`[rate-limit] Redis INCR failed for ${key}:`, err?.message || err);
    return nextLocal;
  }
}
