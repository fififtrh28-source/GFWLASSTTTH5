import { readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);

const inputPath = process.argv[2]
  ? join(process.cwd(), process.argv[2])
  : join(repoRoot, "RUNYOLO_FINALBISMILLAH", "new", "metadata", "metadata_with_vv_vh_gfw_ais_identity.csv");

const parsedInput = parsePath(inputPath);
const enrichedPath = join(parsedInput.dir, `${parsedInput.base}_sog_cog_enriched${parsedInput.ext}`);
const lookupPath = join(parsedInput.dir, `${parsedInput.base}_needs_external_sog_cog_lookup${parsedInput.ext}`);
const reportPath = join(parsedInput.dir, `${parsedInput.base}_sog_cog_report.txt`);

const csv = readFileSync(inputPath, "utf8");
const { headers, rows } = parseCsv(csv);

const addedColumns = [
  "Sog_original",
  "Cog_original",
  "sog_cog_status",
  "sog_cog_source",
  "sog_cog_source_fields",
  "sog_cog_formula",
  "sog_cog_scene_timestamp_utc",
  "sog_cog_distance_km",
  "sog_cog_time_hours",
];

const outputHeaders = [...headers];
for (const col of addedColumns) {
  if (!outputHeaders.includes(col)) outputHeaders.push(col);
}

const lookupHeaders = [
  "scene",
  "scene_timestamp_utc",
  "MMSI",
  "gfw_vessel_id",
  "gfw_ssvid",
  "Name",
  "category",
  "Center_latitude",
  "Center_longitude",
  "reason",
  "recommended_source",
];

const lookupRows = [];
let alreadyPresent = 0;
let filled = 0;
let filledSogOnly = 0;
let needsLookup = 0;
let invalidPairs = 0;

const sourceFields = [
  "ais_before_timestamp",
  "ais_before_lat",
  "ais_before_lon",
  "ais_after_timestamp",
  "ais_after_lat",
  "ais_after_lon",
].join("|");

const outputRows = rows.map((row) => {
  const out = { ...row };
  const originalSog = value(row.Sog);
  const originalCog = value(row.Cog);
  out.Sog_original = originalSog;
  out.Cog_original = originalCog;
  out.sog_cog_scene_timestamp_utc = sceneTimestamp(row);

  if (originalSog && originalCog) {
    alreadyPresent += 1;
    out.sog_cog_status = "already_present";
    out.sog_cog_source = "existing_Sog_Cog_columns";
    out.sog_cog_source_fields = "Sog|Cog";
    out.sog_cog_formula = "";
    out.sog_cog_distance_km = "";
    out.sog_cog_time_hours = "";
    return out;
  }

  const pair = readAisPair(row);
  if (pair.ok) {
    const distanceKm = haversineKm(pair.beforeLat, pair.beforeLon, pair.afterLat, pair.afterLon);
    const hours = (pair.afterTime.getTime() - pair.beforeTime.getTime()) / 3_600_000;
    const sogKnots = (distanceKm / 1.852) / hours;
    const cog = distanceKm > 1e-9
      ? initialBearing(pair.beforeLat, pair.beforeLon, pair.afterLat, pair.afterLon)
      : null;

    if (!originalSog) out.Sog = formatNumber(sogKnots, 6);
    if (!originalCog && cog !== null) out.Cog = formatNumber(cog, 6);

    out.sog_cog_status = cog === null ? "filled_sog_only_stationary_ais_pair" : "filled_from_ais_before_after";
    out.sog_cog_source = `derived_from_${relative(repoRoot, inputPath)}`;
    out.sog_cog_source_fields = sourceFields;
    out.sog_cog_formula = "SOG_knots=haversine_distance_nm/time_hours; COG_deg=initial_bearing_ais_before_to_ais_after";
    out.sog_cog_distance_km = formatNumber(distanceKm, 6);
    out.sog_cog_time_hours = formatNumber(hours, 6);

    if (cog === null) filledSogOnly += 1;
    else filled += 1;
    return out;
  }

  const hasAnyPairField = [
    row.ais_before_timestamp,
    row.ais_before_lat,
    row.ais_before_lon,
    row.ais_after_timestamp,
    row.ais_after_lat,
    row.ais_after_lon,
  ].some((v) => value(v));

  if (hasAnyPairField) invalidPairs += 1;
  else needsLookup += 1;

  out.sog_cog_status = hasAnyPairField ? "invalid_or_incomplete_ais_pair" : "needs_external_ais_lookup";
  out.sog_cog_source = "not_filled_no_valid_two_timestamped_ais_points";
  out.sog_cog_source_fields = sourceFields;
  out.sog_cog_formula = "requires two AIS points around the SAR scene time";
  out.sog_cog_distance_km = "";
  out.sog_cog_time_hours = "";

  lookupRows.push({
    scene: row.scene ?? "",
    scene_timestamp_utc: out.sog_cog_scene_timestamp_utc,
    MMSI: row.MMSI ?? row.gfw_ssvid ?? "",
    gfw_vessel_id: row.gfw_vessel_id ?? "",
    gfw_ssvid: row.gfw_ssvid ?? "",
    Name: row.Name ?? row.gfw_name ?? "",
    category: row.category ?? "",
    Center_latitude: row.Center_latitude ?? "",
    Center_longitude: row.Center_longitude ?? "",
    reason: out.sog_cog_status,
    recommended_source: "Global Fishing Watch AIS Vessel Presence / vessel AIS track around scene_timestamp_utc",
  });

  return out;
});

writeFileSync(enrichedPath, stringifyCsv(outputHeaders, outputRows), "utf8");
writeFileSync(lookupPath, stringifyCsv(lookupHeaders, lookupRows), "utf8");

const report = [
  "SOG/COG enrichment report",
  "",
  `Input: ${relative(repoRoot, inputPath)}`,
  `Output: ${relative(repoRoot, enrichedPath)}`,
  `External lookup list: ${relative(repoRoot, lookupPath)}`,
  "",
  `Rows: ${rows.length}`,
  `Already had SOG+COG: ${alreadyPresent}`,
  `Filled from ais_before/ais_after: ${filled}`,
  `Filled SOG only because AIS pair was stationary: ${filledSogOnly}`,
  `Invalid/incomplete AIS pair: ${invalidPairs}`,
  `Still needs external AIS lookup: ${needsLookup}`,
  "",
  "Method:",
  "- SOG is calculated in knots from haversine distance between ais_before and ais_after divided by elapsed hours.",
  "- COG is calculated as the initial bearing from ais_before to ais_after in degrees clockwise from north.",
  "- Rows without two valid timestamped AIS points are intentionally left blank.",
  "",
  "Source columns used for derived rows:",
  sourceFields,
  "",
  "Recommended external source for remaining rows:",
  "- Global Fishing Watch API, AIS Vessel Presence / AIS vessel track near each SAR scene timestamp.",
].join("\n");
writeFileSync(reportPath, report, "utf8");

console.log(report);

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

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch !== "\r") {
      field += ch;
    }
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

function readAisPair(row) {
  const beforeTime = parseDate(row.ais_before_timestamp);
  const afterTime = parseDate(row.ais_after_timestamp);
  const beforeLat = number(row.ais_before_lat);
  const beforeLon = number(row.ais_before_lon);
  const afterLat = number(row.ais_after_lat);
  const afterLon = number(row.ais_after_lon);

  const ok = beforeTime
    && afterTime
    && afterTime.getTime() > beforeTime.getTime()
    && finiteLatLon(beforeLat, beforeLon)
    && finiteLatLon(afterLat, afterLon);

  return { ok, beforeTime, afterTime, beforeLat, beforeLon, afterLat, afterLon };
}

function sceneTimestamp(row) {
  const fromScene = value(row.scene)?.match(/(\d{8}T\d{6})/);
  if (fromScene) {
    const s = fromScene[1];
    return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}Z`;
  }

  const epoch = number(row.gfw_sar_bearing_timestamp);
  if (Number.isFinite(epoch) && epoch > 0) {
    return new Date(epoch * 1000).toISOString();
  }

  return "";
}

function parseDate(text) {
  const raw = value(text);
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

function number(text) {
  const n = Number(value(text));
  return Number.isFinite(n) ? n : NaN;
}

function value(text) {
  return String(text ?? "").trim();
}

function finiteLatLon(lat, lon) {
  return Number.isFinite(lat)
    && Number.isFinite(lon)
    && lat >= -90
    && lat <= 90
    && lon >= -180
    && lon <= 180;
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
