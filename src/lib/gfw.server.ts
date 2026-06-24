import type { TrackPoint, TrackResponse, VesselSearchResult } from "./types";

const GFW_BASE = "https://gateway.api.globalfishingwatch.org/v3";

const GFW_EVENT_DATASETS = [
  "public-global-fishing-events:latest",
  "public-global-encounters-events:latest",
  "public-global-loitering-events:latest",
];

const GFW_TRACK_DATASET = "public-global-vessel-track:latest";
const GFW_IDENTITY_DATASET = "public-global-vessel-identity:latest";

const INDONESIA_POLY = {
  type: "Polygon",
  coordinates: [[[95.0, -11.0], [141.0, -11.0], [141.0, 6.0], [95.0, 6.0], [95.0, -11.0]]],
};

function authHeaders() {
  const token = process.env.GFW_TOKEN;
  if (!token) throw new Error("GFW_TOKEN is not configured");
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

function toIsoDate(date: string): string {
  // "2012-01-01" → "2012-01-01T00:00:00Z"
  return date.includes("T") ? date : `${date}T00:00:00Z`;
}

export async function searchVessels(query: string, limit = 20): Promise<VesselSearchResult[]> {
  const url = new URL(`${GFW_BASE}/vessels/search`);
  url.searchParams.set("query", query);
  url.searchParams.set("limit", String(Math.min(50, Math.max(1, limit))));
  url.searchParams.set("datasets[0]", GFW_IDENTITY_DATASET);
  url.searchParams.set("includes[0]", "MATCH_CRITERIA");
  url.searchParams.set("includes[1]", "OWNERSHIP");
  const res = await fetch(url.toString(), { headers: authHeaders() });
  if (!res.ok) throw new Error(`GFW search failed: ${res.status}`);
  const json: any = await res.json();
  const entries: any[] = json?.entries ?? json?.data ?? [];
  return entries.slice(0, limit).map((e: any) => {
    const sd = e?.selfReportedInfo?.[0] ?? e?.registryInfo?.[0] ?? e ?? {};
    return {
      vessel_id: e?.selfReportedInfo?.[0]?.id || e?.id || e?.vesselId || "",
      ship_name: sd?.shipname || sd?.shipName || e?.shipname || e?.name,
      mmsi: sd?.ssvid || e?.ssvid || e?.mmsi,
      imo: sd?.imo || e?.imo,
      flag: sd?.flag || e?.flag,
      callsign: sd?.callsign || e?.callsign,
    } as VesselSearchResult;
  }).filter(v => v.vessel_id);
}

function computeBounds(track: TrackPoint[]): TrackResponse["bounds"] {
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

export async function getTrack(vesselId: string, startDate: string, endDate: string): Promise<TrackResponse> {
  const url = new URL(`${GFW_BASE}/vessels/${encodeURIComponent(vesselId)}/tracks`);
  url.searchParams.set("datasets[0]", GFW_TRACK_DATASET);
  url.searchParams.set("start-date", startDate);
  url.searchParams.set("end-date", endDate);

  let track: TrackPoint[] = [];
  let source = "tracks";
  const res = await fetch(url.toString(), { headers: authHeaders() });

  if (res.ok) {
    const json: any = await res.json();
    // GFW track response is GeoJSON LineString with coordinateProperties
    const coords: number[][] = json?.geometry?.coordinates ?? json?.features ?? json?.entries ?? [];
    const coordProps = json?.properties?.coordinateProperties ?? {};
    const times: any[] = coordProps?.times ?? coordProps?.time ?? [];
    const speeds: any[] = coordProps?.speed ?? coordProps?.speeds ?? [];
    const courses: any[] = coordProps?.course ?? coordProps?.courses ?? [];

    if (Array.isArray(coords) && coords.length && Array.isArray(coords[0])) {
      track = coords.map((c: number[], i: number) => ({
        lon: c[0],
        lat: c[1],
        timestamp: times[i] ? new Date(typeof times[i] === "number" ? times[i] * (times[i] > 10_000_000_000 ? 1 : 1000) : times[i]).toISOString() : undefined,
        speed: speeds[i],
        course: courses[i],
      })).filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lon));
    } else {
      // fallback: array of point objects
      const entries: any[] = Array.isArray(json) ? json : (json?.entries ?? []);
      track = entries.map((e: any) => ({
        lat: Number(e?.lat ?? e?.latitude ?? e?.geometry?.coordinates?.[1]),
        lon: Number(e?.lon ?? e?.longitude ?? e?.geometry?.coordinates?.[0]),
        timestamp: e?.timestamp ?? e?.properties?.timestamp,
        speed: e?.speed ?? e?.properties?.speed,
        course: e?.course ?? e?.properties?.course,
      })).filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lon));
    }
  } else if (res.status === 404) {
    // Fallback: use event positions as track points
    source = "events";
    const evUrl = new URL(`${GFW_BASE}/events`);
    evUrl.searchParams.set("limit", "200");
    evUrl.searchParams.set("offset", "0");
    evUrl.searchParams.set("sort", "+start");
    const evRes = await fetch(evUrl.toString(), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        datasets: GFW_EVENT_DATASETS,
        startDate: toIsoDate(startDate),
        endDate: toIsoDate(endDate),
        vessels: [vesselId],
      }),
    });
    if (evRes.ok) {
      const j: any = await evRes.json();
      const entries: any[] = j?.entries ?? [];
      track = entries.map((e: any) => ({
        lat: Number(e?.position?.lat),
        lon: Number(e?.position?.lon),
        timestamp: e?.start,
        speed: undefined,
        course: undefined,
      })).filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lon));
    }
  } else {
    throw new Error(`GFW track failed: ${res.status}`);
  }

  return {
    vessel_id: vesselId,
    start_date: startDate,
    end_date: endDate,
    source,
    count: track.length,
    bounds: computeBounds(track),
    track,
  };
}

// Fetch fishing/encounter/loitering events for Indonesian waters
// Matches server.py gfw_fetch() approach: one POST, all datasets, camelCase dates
export async function getIndonesianEvents(startDate: string, endDate: string) {
  const url = new URL(`${GFW_BASE}/events`);
  url.searchParams.set("limit", "200");
  url.searchParams.set("offset", "0");
  url.searchParams.set("sort", "-start");

  const res = await fetch(url.toString(), {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      datasets: GFW_EVENT_DATASETS,
      startDate: toIsoDate(startDate),
      endDate: toIsoDate(endDate),
      geometry: INDONESIA_POLY,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GFW events failed: ${res.status} ${text.slice(0, 200)}`);
  }

  const json: any = await res.json();
  return json?.entries ?? [];
}
