import { applyRateLimit } from "../../_rate-limit.js";

const INFERENCE_BASE = process.env.INFERENCE_URL || "https://ngenss12-inferencegfw.hf.space";

function pickQuery(req) {
  const params = new URLSearchParams();
  for (const key of ["start_date", "end_date", "max_vessels", "task"]) {
    const value = req.query?.[key];
    if (value == null) continue;
    params.set(key, Array.isArray(value) ? value[0] : value);
  }
  if (!params.has("max_vessels")) params.set("max_vessels", "0");
  if (!params.has("task")) params.set("task", "all");
  return params;
}

export default async function handler(req, res) {
  const allowed = await applyRateLimit(req, res, {
    name: "inference-gfw-stream",
    limit: 12,
    windowSeconds: 10 * 60,
  });
  if (!allowed) return;

  const upstreamUrl = `${INFERENCE_BASE}/inference/gfw/stream?${pickQuery(req)}`;

  try {
    const upstream = await fetch(upstreamUrl, {
      headers: { accept: "text/event-stream" },
    });

    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text().catch(() => "");
      res.status(upstream.status || 502).json({
        error: "Inference stream failed",
        detail: text.slice(0, 500) || `HTTP ${upstream.status}`,
      });
      return;
    }

    res.status(200);
    res.setHeader("content-type", "text/event-stream; charset=utf-8");
    res.setHeader("cache-control", "no-cache, no-transform");
    res.setHeader("connection", "keep-alive");
    res.flushHeaders?.();

    const reader = upstream.body.getReader();
    const close = () => reader.cancel().catch(() => {});
    req.on?.("close", close);

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    res.end();
  } catch (err) {
    if (!res.headersSent) {
      res.status(502).json({
        error: "Inference server unavailable",
        detail: err?.message || "stream proxy failed",
      });
      return;
    }
    res.write(`event: error\ndata: ${JSON.stringify({ error: err?.message || "stream proxy failed" })}\n\n`);
    res.end();
  }
}
