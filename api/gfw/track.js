import { cacheGet, cacheSet } from "../_redis.js";
import { applyRateLimit } from "../_rate-limit.js";

const GFW_BASE = "https://gateway.api.globalfishingwatch.org/v3";
const GFW_TRACK_DATASET = "public-global-vessel-track:latest";
const GFW_EVENT_DATASETS = [
  "public-global-fishing-events:latest",
  "public-global-encounters-events:latest",
  "public-global-loitering-events:latest",
];

function toIsoDate(date) {
  return date.includes("T") ? date : `${date}T00:00:00Z`;
}

function computeBounds(track) {
  if (!track.length) return null;
  let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
  for (const p of track) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
  }
  return [[minLat, minLon], [maxLat, maxLon]];
}

function cacheKey(vesselId, startDate, endDate) {
  return `gfw:track:v2:${encodeURIComponent(vesselId)}:${startDate}:${endDate}`;
}

export default async function handler(req, res) {
  const vesselId = req.query.vessel_id || "";
  const startDate = req.query.start_date || "";
  const endDate = req.query.end_date || "";

  if (!vesselId || !startDate || !endDate) {
    return res.status(400).json({ error: "vessel_id, start_date, end_date required" });
  }

  const allowed = await applyRateLimit(req, res, {
    name: "gfw-track",
    limit: 60,
    windowSeconds: 10 * 60,
  });
  if (!allowed) return;

  const key = cacheKey(vesselId, startDate, endDate);
  const cached = await cacheGet(key);
  if (cached?.payload) {
    res.setHeader("x-cache", "HIT");
    res.setHeader("cache-control", "public, max-age=300, stale-while-revalidate=3600");
    res.setHeader("x-data-fetched-at", new Date(cached.fetchedAt).toISOString());
    return res.json(cached.payload);
  }

  const token = process.env.GFW_TOKEN;
  if (!token) return res.status(500).json({ error: "GFW_TOKEN not configured" });

  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  let track = [];
  let source = "tracks";

  try {
    const url = new URL(`${GFW_BASE}/vessels/${encodeURIComponent(vesselId)}/tracks`);
    url.searchParams.set("datasets[0]", GFW_TRACK_DATASET);
    url.searchParams.set("start-date", startDate);
    url.searchParams.set("end-date", endDate);

    const gfwRes = await fetch(url.toString(), { headers });

    if (gfwRes.ok) {
      const json = await gfwRes.json();
      const coords = json?.geometry?.coordinates ?? json?.features ?? json?.entries ?? [];
      const coordProps = json?.properties?.coordinateProperties ?? {};
      const times = coordProps?.times ?? coordProps?.time ?? [];
      const speeds = coordProps?.speed ?? coordProps?.speeds ?? [];
      const courses = coordProps?.course ?? coordProps?.courses ?? [];

      if (Array.isArray(coords) && coords.length && Array.isArray(coords[0])) {
        track = coords.map((c, i) => ({
          lon: c[0],
          lat: c[1],
          timestamp: times[i]
            ? new Date(typeof times[i] === "number" ? times[i] * (times[i] > 10_000_000_000 ? 1 : 1000) : times[i]).toISOString()
            : undefined,
          speed: speeds[i],
          course: courses[i],
        })).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
      } else {
        const entries = Array.isArray(json) ? json : (json?.entries ?? []);
        track = entries.map((e) => ({
          lat: Number(e?.lat ?? e?.latitude ?? e?.geometry?.coordinates?.[1]),
          lon: Number(e?.lon ?? e?.longitude ?? e?.geometry?.coordinates?.[0]),
          timestamp: e?.timestamp ?? e?.properties?.timestamp,
          speed: e?.speed ?? e?.properties?.speed,
          course: e?.course ?? e?.properties?.course,
        })).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
      }
    } else if (gfwRes.status === 404) {
      source = "events";
      const evUrl = new URL(`${GFW_BASE}/events`);
      evUrl.searchParams.set("limit", "200");
      evUrl.searchParams.set("offset", "0");
      evUrl.searchParams.set("sort", "+start");

      const evRes = await fetch(evUrl.toString(), {
        method: "POST",
        headers,
        body: JSON.stringify({
          datasets: GFW_EVENT_DATASETS,
          startDate: toIsoDate(startDate),
          endDate: toIsoDate(endDate),
          vessels: [vesselId],
        }),
      });

      if (evRes.ok) {
        const j = await evRes.json();
        const entries = j?.entries ?? [];
        track = entries.map((e) => ({
          lat: Number(e?.position?.lat),
          lon: Number(e?.position?.lon),
          timestamp: e?.start,
          speed: undefined,
          course: undefined,
        })).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
      }
    } else {
      throw new Error(`GFW track failed: ${gfwRes.status}`);
    }

    const payload = {
      vessel_id: vesselId,
      start_date: startDate,
      end_date: endDate,
      source,
      count: track.length,
      bounds: computeBounds(track),
      track,
    };
    await cacheSet(key, { payload, fetchedAt: Date.now() }, 6 * 60 * 60);
    res.setHeader("x-cache", "MISS");
    res.setHeader("cache-control", "public, max-age=300, stale-while-revalidate=3600");
    res.json(payload);
  } catch (e) {
    if (cached?.payload) {
      res.setHeader("x-cache", "STALE");
      res.setHeader("cache-control", "public, max-age=60, stale-while-revalidate=3600");
      return res.json({
        ...cached.payload,
        warning: "Serving stale GFW track because live fetch failed",
      });
    }
    res.status(500).json({ error: e?.message || "track failed" });
  }
}
