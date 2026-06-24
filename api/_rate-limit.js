import { incrementWithTtl } from "./_redis.js";

function getHeader(req, name) {
  const headers = req.headers || {};
  return headers[name] || headers[name.toLowerCase()] || headers[name.toUpperCase()] || "";
}

function getClientIp(req) {
  const forwarded = getHeader(req, "x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return (
    getHeader(req, "x-real-ip") ||
    getHeader(req, "cf-connecting-ip") ||
    req.socket?.remoteAddress ||
    "unknown"
  );
}

function sanitizePart(value) {
  return String(value || "unknown").replace(/[^a-zA-Z0-9:._-]/g, "_").slice(0, 120);
}

export async function applyRateLimit(req, res, { name, limit, windowSeconds }) {
  const ip = sanitizePart(getClientIp(req));
  const bucket = Math.floor(Date.now() / (windowSeconds * 1000));
  const key = `rl:${sanitizePart(name)}:${ip}:${bucket}`;
  const count = await incrementWithTtl(key, windowSeconds + 5);
  const remaining = Math.max(0, limit - count);

  res.setHeader("x-ratelimit-limit", String(limit));
  res.setHeader("x-ratelimit-remaining", String(remaining));
  res.setHeader("x-ratelimit-window", String(windowSeconds));

  if (count <= limit) return true;

  res.setHeader("retry-after", String(windowSeconds));
  res.status(429).json({
    error: "Too many requests",
    retry_after_seconds: windowSeconds,
  });
  return false;
}
