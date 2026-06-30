import { cacheGet, cacheSet } from "../../_redis.js";
import { applyRateLimit } from "../../_rate-limit.js";

const INFERENCE_BASE = process.env.INFERENCE_URL || "https://ngenss12-inferencegfw.hf.space";
const CACHE_KEY = "inference:batch:latest:v1";
const CACHE_TTL_SECONDS = 30;

function normalizeBatchPayload(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return {
      vessels: [],
      raw_track: [],
      warning: "Inference batch latest returned an empty payload.",
    };
  }

  return {
    ...data,
    vessels: Array.isArray(data.vessels) ? data.vessels : [],
    raw_track: Array.isArray(data.raw_track) ? data.raw_track : [],
  };
}

export default async function handler(req, res) {
  const allowed = await applyRateLimit(req, res, {
    name: "inference-batch-latest",
    limit: 120,
    windowSeconds: 10 * 60,
  });
  if (!allowed) return;

  const cached = await cacheGet(CACHE_KEY);
  if (cached?.payload) {
    res.setHeader("x-cache", "HIT");
    res.setHeader("cache-control", "public, max-age=15, stale-while-revalidate=60");
    return res.json(cached.payload);
  }

  try {
    const upstream = await fetch(`${INFERENCE_BASE}/inference/batch/latest`, {
      signal: AbortSignal.timeout(15000),
    });
    const data = await upstream.json().catch(() => null);

    if (!upstream.ok) {
      return res.status(upstream.status).json(data || {
        error: "Inference batch latest failed",
        detail: `HTTP ${upstream.status}`,
      });
    }

    const payload = normalizeBatchPayload(data);
    await cacheSet(CACHE_KEY, { payload, fetchedAt: Date.now() }, CACHE_TTL_SECONDS);
    res.setHeader("x-cache", "MISS");
    res.setHeader("cache-control", "public, max-age=15, stale-while-revalidate=60");
    res.json(payload);
  } catch (err) {
    res.status(502).json({
      error: "Inference server unavailable",
      detail: err?.message || "batch latest failed",
    });
  }
}
