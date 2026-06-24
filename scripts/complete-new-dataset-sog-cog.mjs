import { readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);

const inputPath = process.argv[2]
  ? join(process.cwd(), process.argv[2])
  : join(repoRoot, "new", "metadata", "metadata_with_vv_vh_gfw_ais_identity_sog_cog_enriched_ais_position_enriched.csv");

const parsed = parsePath(inputPath);
const outputPath = join(parsed.dir, `${parsed.base}_completed${parsed.ext}`);
const reportPath = join(parsed.dir, `${parsed.base}_completed_report.txt`);
const lookupPath = join(parsed.dir, `${parsed.base}_still_missing_sog_cog.csv`);

const csv = readFileSync(inputPath, "utf8");
const { headers, rows } = parseCsv(csv);

const addedColumns = [
  "sog_cog_completion_status",
  "sog_cog_completion_source",
  "sog_cog_completion_note",
  "sog_cog_completion_scene_timestamp_utc",
  "sog_cog_completion_track_window_days",
  "sog_cog_completion_nearest_track_time",
  "sog_cog_completion_nearest_track_minutes",
];

const outputHeaders = [...headers];
for (const col of addedColumns) {
  if (!outputHeaders.includes(col)) outputHeaders.push(col);
}

const missingBefore = rows.filter(hasMissingSogOrCog).length;
let alreadyComplete = 0;
let filledFromGfwObserved = 0;
let filledFromGfwComputedPair = 0;
let filledStationaryCogPlaceholder = 0;
let stillMissing = 0;
let gfwNoTrack = 0;
let gfwErrors = 0;

const trackCache = new Map();
const windows = [1, 3, 7, 14];

for (let i = 0; i < rows.length; i += 1) {
  const row = rows[i];
  row.sog_cog_completion_scene_timestamp_utc = sceneTimestamp(row);
  row.sog_cog_completion_track_window_days = "";
  row.sog_cog_completion_nearest_track_time = "";
  row.sog_cog_completion_nearest_track_minutes = "";

  if (!hasMissingSogOrCog(row)) {
    alreadyComplete += 1;
    row.sog_cog_completion_status = "already_complete";
    row.sog_cog_completion_source = "existing_dataset_columns";
    row.sog_cog_completion_note = "";
    continue;
  }

  const sceneTime = parseDate(row.sog_cog_completion_scene_timestamp_utc);
  const vesselId = value(row.gfw_vessel_id);

  if (sceneTime && vesselId) {
    const gfw = await lookupGfwTrack(vesselId, sceneTime);
    if (gfw.error) gfwErrors += 1;
    if (gfw.noTrack) gfwNoTrack += 1;
    if (gfw.fill) {
      if (isBlank(row.Sog) && Number.isFinite(gfw.fill.sog)) row.Sog = formatNumber(gfw.fill.sog, 6);
      if (isBlank(row.Cog) && Number.isFinite(gfw.fill.cog)) row.Cog = formatNumber(gfw.fill.cog, 6);
      row.sog_cog_completion_status = gfw.fill.kind;
      row.sog_cog_completion_source = `Global Fishing Watch track via local /api/gfw/track`;
      row.sog_cog_completion_note = gfw.fill.note;
      row.sog_cog_completion_track_window_days = String(gfw.fill.windowDays);
      row.sog_cog_completion_nearest_track_time = gfw.fill.nearestTime ?? "";
      row.sog_cog_completion_nearest_track_minutes = gfw.fill.nearestMinutes != null ? formatNumber(gfw.fill.nearestMinutes, 3) : "";

      if (gfw.fill.kind === "filled_from_gfw_track_observed_speed_course") filledFromGfwObserved += 1;
      if (gfw.fill.kind === "filled_from_gfw_track_computed_neighbor_pair") filledFromGfwComputedPair += 1;
    }
  }

  if (hasMissingSogOrCog(row) && isBlank(row.Cog) && !isBlank(row.Sog) && number(row.Sog) === 0) {
    row.Cog = "0";
    row.sog_cog_completion_status = "filled_stationary_cog_placeholder";
    row.sog_cog_completion_source = "computational_placeholder";
    row.sog_cog_completion_note = "COG is not physically meaningful when SOG is 0; filled with 0 so Kalman velocity remains zero.";
    filledStationaryCogPlaceholder += 1;
  }

  if (hasMissingSogOrCog(row)) {
    stillMissing += 1;
    if (!row.sog_cog_completion_status) {
      row.sog_cog_completion_status = "still_missing_no_valid_source";
      row.sog_cog_completion_source = "not_filled";
      row.sog_cog_completion_note = "No observed SOG/COG in dataset and no usable GFW track point/pair was found.";
    }
  }
}

writeFileSync(outputPath, stringifyCsv(outputHeaders, rows), "utf8");
writeFileSync(lookupPath, stringifyCsv(outputHeaders, rows.filter(hasMissingSogOrCog)), "utf8");

const missingAfter = rows.filter(hasMissingSogOrCog).length;
const report = [
  "SOG/COG completion report",
  "",
  `Input: ${relative(repoRoot, inputPath)}`,
  `Output: ${relative(repoRoot, outputPath)}`,
  `Still missing list: ${relative(repoRoot, lookupPath)}`,
  "",
  `Rows: ${rows.length}`,
  `Missing SOG or COG before: ${missingBefore}`,
  `Already complete: ${alreadyComplete}`,
  `Filled from GFW observed speed/course: ${filledFromGfwObserved}`,
  `Filled from GFW computed neighbor pair: ${filledFromGfwComputedPair}`,
  `Filled stationary COG placeholder where SOG=0: ${filledStationaryCogPlaceholder}`,
  `GFW lookups with no track: ${gfwNoTrack}`,
  `GFW lookup errors: ${gfwErrors}`,
  `Still missing after: ${missingAfter}`,
  "",
  "Rules:",
  "- GFW observed speed/course is used only when the track response contains speed/course near the SAR scene timestamp.",
  "- If speed/course is unavailable but neighboring GFW track points exist around the scene time, SOG/COG is computed from the neighbor pair.",
  "- If SOG is 0 and COG is blank, COG is filled with 0 as a computational placeholder. This is marked clearly because COG has no physical direction when speed is zero.",
  "- SOG is never invented. Rows without an observed or computable speed remain blank.",
].join("\n");
writeFileSync(reportPath, report, "utf8");
console.log(report);

async function lookupGfwTrack(vesselId, sceneTime) {
  for (const windowDays of windows) {
    const start = dateOnly(addDays(sceneTime, -windowDays));
    const end = dateOnly(addDays(sceneTime, windowDays + 1));
    const key = `${vesselId}|${start}|${end}`;
    let data = trackCache.get(key);
    if (!data) {
      const url = `http://127.0.0.1:5175/api/gfw/track?vessel_id=${encodeURIComponent(vesselId)}&start_date=${start}&end_date=${end}`;
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
        data = res.ok ? await res.json() : { error: `HTTP ${res.status}`, track: [] };
      } catch (error) {
        data = { error: error?.message || "fetch failed", track: [] };
      }
      trackCache.set(key, data);
    }

    const track = Array.isArray(data?.track) ? data.track
      .map((p) => ({
        ...p,
        lat: number(p.lat),
        lon: number(p.lon),
        speed: number(p.speed),
        course: number(p.course),
        time: parseDate(p.timestamp),
      }))
      .filter((p) => finiteLatLon(p.lat, p.lon) && p.time)
      .sort((a, b) => a.time - b.time) : [];

    if (!track.length) {
      if (data?.error) return { error: true };
      continue;
    }

    const nearest = nearestPoint(track, sceneTime);
    if (nearest && Number.isFinite(nearest.speed) && Number.isFinite(nearest.course)) {
      return {
        fill: {
          kind: "filled_from_gfw_track_observed_speed_course",
          sog: nearest.speed,
          cog: nearest.course,
          windowDays,
          nearestTime: nearest.timestamp,
          nearestMinutes: Math.abs(nearest.time - sceneTime) / 60_000,
          note: "Used nearest GFW track point with observed speed/course.",
        },
      };
    }

    const pair = surroundingPair(track, sceneTime);
    if (pair) {
      const distanceKm = haversineKm(pair.before.lat, pair.before.lon, pair.after.lat, pair.after.lon);
      const hours = (pair.after.time - pair.before.time) / 3_600_000;
      if (hours > 0) {
        return {
          fill: {
            kind: "filled_from_gfw_track_computed_neighbor_pair",
            sog: (distanceKm / 1.852) / hours,
            cog: distanceKm > 1e-9 ? initialBearing(pair.before.lat, pair.before.lon, pair.after.lat, pair.after.lon) : 0,
            windowDays,
            nearestTime: nearest?.timestamp,
            nearestMinutes: nearest ? Math.abs(nearest.time - sceneTime) / 60_000 : undefined,
            note: "Computed from neighboring GFW track points around scene timestamp.",
          },
        };
      }
    }
  }

  return { noTrack: true };
}

function nearestPoint(track, sceneTime) {
  let best = null;
  let bestMs = Infinity;
  for (const p of track) {
    const d = Math.abs(p.time - sceneTime);
    if (d < bestMs) {
      best = p;
      bestMs = d;
    }
  }
  return best;
}

function surroundingPair(track, sceneTime) {
  let before = null;
  let after = null;
  for (const p of track) {
    if (p.time <= sceneTime) before = p;
    if (p.time >= sceneTime) {
      after = p;
      break;
    }
  }
  if (before && after && before !== after) return { before, after };
  return null;
}

function parsePath(path) {
  const ext = extname(path);
  return {
    dir: dirname(path),
    base: path.slice(dirname(path).length + 1, path.length - ext.length),
    ext,
  };
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (inQuotes) {
      if (ch === '"' && next === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') inQuotes = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch !== "\r") field += ch;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  const headers = rows.shift() ?? [];
  return {
    headers,
    rows: rows
      .filter((r) => r.some((cell) => cell.trim() !== ""))
      .map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ""]))),
  };
}

function stringifyCsv(headers, rows) {
  return [
    headers.map(escapeCsv).join(","),
    ...rows.map((row) => headers.map((h) => escapeCsv(row[h] ?? "")).join(",")),
  ].join("\n") + "\n";
}

function escapeCsv(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function hasMissingSogOrCog(row) {
  return isBlank(row.Sog) || isBlank(row.Cog);
}

function isBlank(v) {
  return value(v) === "";
}

function sceneTimestamp(row) {
  const fromScene = value(row.scene)?.match(/(\d{8}T\d{6})/);
  if (fromScene) {
    const s = fromScene[1];
    return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}Z`;
  }
  const epoch = number(row.gfw_sar_bearing_timestamp);
  if (Number.isFinite(epoch) && epoch > 0) return new Date(epoch * 1000).toISOString();
  return "";
}

function parseDate(text) {
  const raw = value(text);
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

function dateOnly(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function number(text) {
  const n = Number(value(text));
  return Number.isFinite(n) ? n : NaN;
}

function value(text) {
  return String(text ?? "").trim();
}

function finiteLatLon(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const earthKm = 6371.0088;
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const dPhi = toRad(lat2 - lat1);
  const dLambda = toRad(lon2 - lon1);
  const a = Math.sin(dPhi / 2) ** 2
    + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
  return 2 * earthKm * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function initialBearing(lat1, lon1, lat2, lon2) {
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const dLambda = toRad(lon2 - lon1);
  const y = Math.sin(dLambda) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2)
    - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function toRad(deg) {
  return deg * Math.PI / 180;
}

function toDeg(rad) {
  return rad * 180 / Math.PI;
}

function formatNumber(n, digits) {
  return Number.isFinite(n) ? n.toFixed(digits).replace(/\.?0+$/, "") : "";
}
