import { applyRateLimit } from "../_rate-limit.js";

const INFERENCE_BASE = process.env.INFERENCE_URL || "https://ngenss12-inferencegfw.hf.space";

export default async function handler(req, res) {
  const allowed = await applyRateLimit(req, res, {
    name: "inference-health",
    limit: 60,
    windowSeconds: 10 * 60,
  });
  if (!allowed) return;

  try {
    const upstream = await fetch(`${INFERENCE_BASE}/health`, {
      signal: AbortSignal.timeout(8000),
    });
    const body = await upstream.text();
    res.status(upstream.status);
    res.setHeader("content-type", upstream.headers.get("content-type") || "application/json");
    res.send(body);
  } catch (err) {
    res.status(502).json({
      error: "Inference server unavailable",
      detail: err?.message || "health check failed",
    });
  }
}
