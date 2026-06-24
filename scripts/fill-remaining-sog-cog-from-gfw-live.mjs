import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const defaultInput = join(repoRoot, "new", "metadata", "metadata_with_vh_gfw_ais_identity_sog_cog_enriched_FINAL.csv");
const inputPath = process.argv[2] ? join(process.cwd(), process.argv[2]) : defaultInput;
const outputDir = dirname(inputPath);
const outputPath = inputPath;
const auditPath = join(outputDir, "still_missing_sog_cog_audit.csv");
const reportPath = join(outputDir, "metadata_with_vh_gfw_ais_identity_sog_cog_enriched_FINAL_gfw_live_report.txt");

const GFW_BASE = "https://gateway.api.globalfishingwatch.org/v3";
const GFW_TRACK_DATASET = "public-global-vessel-track:latest";
const GFW_EVENT_DATASETS = [
  "public-global-fishing-events:latest",
  "public-global-encounters-events:latest",
  "public-global-loitering-events:latest",
];
const WINDOWS_DAYS = [1, 3, 7, 14];
const KNOTS_PER_MPS = 1.94384;

loadEnvIfNeeded();

const token = process.env.GFW_TOKEN;
if (!token) {
  throw new Error("GFW_TOKEN tidak ditemukan di environment atau .env.lokal");
}

const { headers, rows } = parseCsv(readFileSync(inputPath, "utf8"));
const outputHeaders = [...headers];
for (const col of [
  "SOG_calc",
  "COG_calc",
  "sog_cog_source",
  "sog_cog_formula",
  "sog_cog_status",
  "distance_m",
  "delta_time_s",
  "gfw_live_track_window_days",
  "gfw_live_track_point_count",
  "gfw_live_track_nearest_time",
  "gfw_live_track_nearest_minutes",
]) {
  if (!outputHeaders.includes(col)) outputHeaders.push(col);
}

const missingBefore = rows.filter(hasMissingSogOrCog).length;
let filledObserved = 0;
let filledPair = 0;
let filledStationaryCogPlaceholder = 0;
let noTrack = 0;
let errors = 0;

for (const row of rows) {
  if (!hasMissingSogOrCog(row)) continue;

  const vesselId = value(row.gfw_vessel_id);
  const sceneTime = sceneTimestamp(row) ?? parseDateish(row.sog_cog_scene_timestamp_utc) ?? parseDateish(row.gfw_sar_bearing_timestamp);
  if (!vesselId || !sceneTime) {
    markStillMissing(row, "still_missing_no_gfw_vessel_id_or_scene_time");
    continue;
  }

  const result = await lookupGfwTrack(vesselId, sceneTime);
  if (result.error) errors += 1;
  if (result.noTrack) noTrack += 1;

  if (result.fill) {
    if (isBlank(row.Sog) && Number.isFinite(result.fill.sog)) row.Sog = formatNumber(result.fill.sog, 6);
    if (isBlank(row.Cog) && Number.isFinite(result.fill.cog)) row.Cog = formatAngle(result.fill.cog);

    row.SOG_calc = value(row.Sog);
    row.COG_calc = value(row.Cog);
    row.sog_cog_source = result.fill.source;
    row.sog_cog_status = result.fill.status;
    row.sog_cog_formula = result.fill.formula;
    row.sog_cog_source_fields = "GFW public-global-vessel-track:latest";
    row.distance_m = Number.isFinite(result.fill.distanceM) ? formatNumber(result.fill.distanceM, 3) : "";
    row.delta_time_s = Number.isFinite(result.fill.deltaTimeS) ? formatNumber(result.fill.deltaTimeS, 3) : "";
    row.sog_cog_distance_km = Number.isFinite(result.fill.distanceM) ? formatNumber(result.fill.distanceM / 1000, 6) : "";
    row.sog_cog_time_hours = Number.isFinite(result.fill.deltaTimeS) ? formatNumber(result.fill.deltaTimeS / 3600, 6) : "";
    row.gfw_live_track_window_days = String(result.fill.windowDays);
    row.gfw_live_track_point_count = String(result.fill.trackCount);
    row.gfw_live_track_nearest_time = result.fill.nearestTime ?? "";
    row.gfw_live_track_nearest_minutes = Number.isFinite(result.fill.nearestMinutes) ? formatNumber(result.fill.nearestMinutes, 3) : "";

    if (result.fill.status === "filled_from_gfw_track_observed_speed_course") filledObserved += 1;
    if (result.fill.status === "filled_from_gfw_track_computed_neighbor_pair") filledPair += 1;
  } else if (hasMissingSogOrCog(row)) {
    markStillMissing(row, result.status ?? "still_missing_no_gfw_track_pair_or_observed_speed_course");
  }
}

for (const row of rows) {
  if (isBlank(row.Cog) && !isBlank(row.Sog) && number(row.Sog) === 0) {
    row.Cog = "0";
    row.COG_calc = "0";
    row.sog_cog_source = "stationary_cog_placeholder";
    row.sog_cog_status = "stationary_cog_placeholder_not_physical";
    row.sog_cog_formula = "COG set to 0 only because SOG is 0; course over ground is physically undefined for a stationary vessel; use status column for audit";
    filledStationaryCogPlaceholder += 1;
  }
}

const missingRows = rows.filter(hasMissingSogOrCog);
writeFileSync(outputPath, stringifyCsv(outputHeaders, rows), "utf8");
writeFileSync(auditPath, stringifyCsv(outputHeaders, missingRows), "utf8");

const report = [
  "GFW live SOG/COG fill report",
  "",
  `Input/output: ${relative(repoRoot, outputPath)}`,
  `Still missing audit: ${relative(repoRoot, auditPath)}`,
  "",
  `Missing rows before GFW live: ${missingBefore}`,
  `Filled from GFW observed speed/course: ${filledObserved}`,
  `Filled from GFW computed neighbor pair: ${filledPair}`,
  `Filled stationary COG placeholder where SOG=0: ${filledStationaryCogPlaceholder}`,
  `GFW no track: ${noTrack}`,
  `GFW errors: ${errors}`,
  `Missing rows after GFW live: ${missingRows.length}`,
].join("\n");

writeFileSync(reportPath, report, "utf8");
console.log(report);

async function lookupGfwTrack(vesselId, sceneTime) {
  for (const windowDays of WINDOWS_DAYS) {
    const start = dateOnly(addDays(sceneTime, -windowDays));
    const end = dateOnly(addDays(sceneTime, windowDays + 1));
    const trackResult = await fetchTrack(vesselId, start, end);
    if (trackResult.error) return { error: true, status: trackResult.error };

    const track = trackResult.track
      .map((p) => ({
        ...p,
        lat: number(p.lat),
        lon: number(p.lon),
        speed: number(p.speed),
        course: number(p.course),
        time: parseDateish(p.timestamp),
      }))
      .filter((p) => finiteLatLon(p.lat, p.lon) && p.time)
      .sort((a, b) => a.time - b.time);

    if (!track.length) continue;

    const nearest = nearestPoint(track, sceneTime);
    if (nearest && Number.isFinite(nearest.speed) && Number.isFinite(nearest.course)) {
      return {
        fill: {
          status: "filled_from_gfw_track_observed_speed_course",
          source: "gfw_live_track_observed_speed_course",
          sog: nearest.speed,
          cog: nearest.course,
          formula: "SOG/COG copied from nearest observed GFW AIS track point; not interpolated",
          windowDays,
          trackCount: track.length,
          nearestTime: nearest.timestamp,
          nearestMinutes: Math.abs(nearest.time - sceneTime) / 60_000,
        },
      };
    }

    const pair = surroundingPair(track, sceneTime);
    if (pair) {
      const distanceM = haversineM(pair.before.lat, pair.before.lon, pair.after.lat, pair.after.lon);
      const deltaTimeS = (pair.after.time - pair.before.time) / 1000;
      if (deltaTimeS > 0) {
        return {
          fill: {
            status: "filled_from_gfw_track_computed_neighbor_pair",
            source: "gfw_live_track_neighbor_pair",
            sog: (distanceM / deltaTimeS) * KNOTS_PER_MPS,
            cog: distanceM >= 5 ? initialBearing(pair.before.lat, pair.before.lon, pair.after.lat, pair.after.lon) : NaN,
            formula: "SOG_knot=(haversine_distance_meter/delta_time_second)*1.94384; COG_deg=initial_bearing_from_GFW_before_to_GFW_after",
            distanceM,
            deltaTimeS,
            windowDays,
            trackCount: track.length,
            nearestTime: nearest?.timestamp,
            nearestMinutes: nearest ? Math.abs(nearest.time - sceneTime) / 60_000 : NaN,
          },
        };
      }
    }
  }

  return { noTrack: true, status: "still_missing_no_gfw_track_pair_or_observed_speed_course" };
}

async function fetchTrack(vesselId, startDate, endDate) {
  const url = new URL(`${GFW_BASE}/vessels/${encodeURIComponent(vesselId)}/tracks`);
  url.searchParams.set("datasets[0]", GFW_TRACK_DATASET);
  url.searchParams.set("start-date", startDate);
  url.searchParams.set("end-date", endDate);

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(60_000),
  });

  if (res.status === 404) {
    return fetchEventTrack(vesselId, startDate, endDate);
  }

  if (!res.ok) {
    return { error: `gfw_track_http_${res.status}`, track: [] };
  }

  const json = await res.json();
  const coords = json?.geometry?.coordinates ?? json?.features ?? json?.entries ?? [];
  const coordProps = json?.properties?.coordinateProperties ?? {};
  const times = coordProps?.times ?? coordProps?.time ?? [];
  const speeds = coordProps?.speed ?? coordProps?.speeds ?? [];
  const courses = coordProps?.course ?? coordProps?.courses ?? [];

  if (Array.isArray(coords) && coords.length && Array.isArray(coords[0])) {
    return {
      track: coords.map((coord, i) => ({
        lon: coord[0],
        lat: coord[1],
        timestamp: times[i] ? parseGfwTime(times[i]) : undefined,
        speed: speeds[i],
        course: courses[i],
      })),
    };
  }

  const entries = Array.isArray(json) ? json : (json?.entries ?? []);
  return {
    track: entries.map((entry) => ({
      lat: Number(entry?.lat ?? entry?.latitude ?? entry?.geometry?.coordinates?.[1]),
      lon: Number(entry?.lon ?? entry?.longitude ?? entry?.geometry?.coordinates?.[0]),
      timestamp: entry?.timestamp ?? entry?.properties?.timestamp,
      speed: entry?.speed ?? entry?.properties?.speed,
      course: entry?.course ?? entry?.properties?.course,
    })),
  };
}

async function fetchEventTrack(vesselId, startDate, endDate) {
  const url = new URL(`${GFW_BASE}/events`);
  url.searchParams.set("limit", "200");
  url.searchParams.set("offset", "0");
  url.searchParams.set("sort", "+start");

  const res = await fetch(url.toString(), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      datasets: GFW_EVENT_DATASETS,
      startDate: toIsoDate(startDate),
      endDate: toIsoDate(endDate),
      vessels: [vesselId],
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) return { error: `gfw_events_http_${res.status}`, track: [] };
  const json = await res.json();
  const entries = json?.entries ?? [];
  return {
    track: entries.map((entry) => ({
      lat: Number(entry?.position?.lat),
      lon: Number(entry?.position?.lon),
      timestamp: entry?.start,
      speed: undefined,
      course: undefined,
    })),
  };
}

function parseGfwTime(input) {
  if (typeof input === "number") return new Date(input * (input > 10_000_000_000 ? 1 : 1000)).toISOString();
  return input;
}

function markStillMissing(row, status) {
  row.SOG_calc = value(row.Sog);
  row.COG_calc = value(row.Cog);
  row.sog_cog_status = status;
  row.sog_cog_source = row.sog_cog_source || "not_filled";
}

function nearestPoint(track, sceneTime) {
  let best = null;
  let bestMs = Infinity;
  for (const point of track) {
    const diffMs = Math.abs(point.time - sceneTime);
    if (diffMs < bestMs) {
      best = point;
      bestMs = diffMs;
    }
  }
  return best;
}

function surroundingPair(track, sceneTime) {
  let before = null;
  let after = null;
  for (const point of track) {
    if (point.time <= sceneTime) before = point;
    if (point.time >= sceneTime) {
      after = point;
      break;
    }
  }
  return before && after && before !== after ? { before, after } : null;
}

function loadEnvIfNeeded() {
  if (process.env.GFW_TOKEN) return;
  const envPath = join(repoRoot, ".env.lokal");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const key = match[1];
    let val = match[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  }
}

function parseCsv(input) {
  const allRows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    const next = input[i + 1];
    if (inQuotes) {
      if (ch === '"' && next === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') inQuotes = false;
      else field += ch;
      continue;
    }
    if (ch === '"') inQuotes = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      allRows.push(row);
      row = [];
      field = "";
    } else if (ch !== "\r") field += ch;
  }
  if (field.length || row.length) {
    row.push(field);
    allRows.push(row);
  }
  const headers = allRows.shift() ?? [];
  return {
    headers,
    rows: allRows
      .filter((cells) => cells.some((cell) => cell.trim() !== ""))
      .map((cells) => Object.fromEntries(headers.map((header, i) => [header, cells[i] ?? ""]))),
  };
}

function stringifyCsv(headers, rows) {
  return [
    headers.map(escapeCsv).join(","),
    ...rows.map((row) => headers.map((header) => escapeCsv(row[header] ?? "")).join(",")),
  ].join("\n") + "\n";
}

function escapeCsv(input) {
  const s = String(input ?? "");
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

function hasMissingSogOrCog(row) {
  return isBlank(row.Sog) || isBlank(row.Cog);
}

function isBlank(input) {
  return value(input) === "";
}

function value(input) {
  return String(input ?? "").trim();
}

function number(input) {
  const raw = value(input);
  if (!raw) return NaN;
  const n = Number(raw);
  return Number.isFinite(n) ? n : NaN;
}

function parseDateish(input) {
  const raw = value(input);
  if (!raw) return null;
  if (/^-?\d+(\.\d+)?$/.test(raw)) {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return null;
    const date = new Date(n > 1e12 ? n : n * 1000);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

function sceneTimestamp(row) {
  const fromScene = value(row.scene).match(/(\d{8}T\d{6})/);
  if (!fromScene) return null;
  const s = fromScene[1];
  const date = new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function finiteLatLon(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
}

function dateOnly(date) {
  return date.toISOString().slice(0, 10);
}

function toIsoDate(date) {
  return date.includes("T") ? date : `${date}T00:00:00Z`;
}

function addDays(date, days) {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function haversineM(lat1, lon1, lat2, lon2) {
  const earthM = 6371008.8;
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const dPhi = toRad(lat2 - lat1);
  const dLambda = toRad(lon2 - lon1);
  const a = Math.sin(dPhi / 2) ** 2
    + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
  return 2 * earthM * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function initialBearing(lat1, lon1, lat2, lon2) {
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const dLambda = toRad(lon2 - lon1);
  const y = Math.sin(dLambda) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2)
    - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);
  return normalizeAngle(toDeg(Math.atan2(y, x)));
}

function normalizeAngle(deg) {
  return ((deg % 360) + 360) % 360;
}

function toRad(deg) {
  return deg * Math.PI / 180;
}

function toDeg(rad) {
  return rad * 180 / Math.PI;
}

function formatNumber(input, digits) {
  return Number.isFinite(input) ? input.toFixed(digits).replace(/\.?0+$/, "") : "";
}

function formatAngle(input) {
  return Number.isFinite(input) ? formatNumber(normalizeAngle(input), 6) : "";
}
