import { cacheGet, cacheSet } from "../../_redis.js";
import { applyRateLimit } from "../../_rate-limit.js";

const GFW_BASE = "https://gateway.api.globalfishingwatch.org/v3";
const GFW_IDENTITY_DATASET = "public-global-vessel-identity:latest";

function cacheKey(query, limit) {
  return `gfw:vessels:search:v1:${encodeURIComponent(query.toLowerCase())}:${limit}`;
}

export default async function handler(req, res) {
  const query = (req.query.query || "").trim();
  const limit = Math.min(50, Number(req.query.limit || "20"));

  if (!query) return res.json({ entries: [] });

  const allowed = await applyRateLimit(req, res, {
    name: "gfw-vessel-search",
    limit: 30,
    windowSeconds: 10 * 60,
  });
  if (!allowed) return;

  const key = cacheKey(query, limit);
  const cached = await cacheGet(key);
  if (cached?.payload) {
    res.setHeader("x-cache", "HIT");
    res.setHeader("cache-control", "public, max-age=600, stale-while-revalidate=86400");
    res.setHeader("x-data-fetched-at", new Date(cached.fetchedAt).toISOString());
    return res.json(cached.payload);
  }

  const token = process.env.GFW_TOKEN;
  if (!token) return res.status(500).json({ entries: [], error: "GFW_TOKEN not configured" });

  try {
    const url = new URL(`${GFW_BASE}/vessels/search`);
    url.searchParams.set("query", query);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("datasets[0]", GFW_IDENTITY_DATASET);
    url.searchParams.set("includes[0]", "MATCH_CRITERIA");
    url.searchParams.set("includes[1]", "OWNERSHIP");

    const gfwRes = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    });

    if (!gfwRes.ok) throw new Error(`GFW search failed: ${gfwRes.status}`);

    const json = await gfwRes.json();
    const raw = json?.entries ?? json?.data ?? [];

    const entries = raw.slice(0, limit).map((e) => {
      const sd = e?.selfReportedInfo?.[0] ?? e?.registryInfo?.[0] ?? e ?? {};
      return {
        vessel_id: e?.selfReportedInfo?.[0]?.id || e?.id || e?.vesselId || "",
        ship_name: sd?.shipname || sd?.shipName || e?.shipname || e?.name,
        mmsi: sd?.ssvid || e?.ssvid || e?.mmsi,
        imo: sd?.imo || e?.imo,
        flag: sd?.flag || e?.flag,
        callsign: sd?.callsign || e?.callsign,
      };
    }).filter((v) => v.vessel_id);

    const payload = { entries };
    await cacheSet(key, { payload, fetchedAt: Date.now() }, 24 * 60 * 60);
    res.setHeader("x-cache", "MISS");
    res.setHeader("cache-control", "public, max-age=600, stale-while-revalidate=86400");
    res.json(payload);
  } catch (e) {
    if (cached?.payload) {
      res.setHeader("x-cache", "STALE");
      res.setHeader("cache-control", "public, max-age=60, stale-while-revalidate=86400");
      return res.json({
        ...cached.payload,
        warning: "Serving stale GFW vessel search because live fetch failed",
      });
    }
    res.status(500).json({ entries: [], error: e?.message || "search failed" });
  }
}
