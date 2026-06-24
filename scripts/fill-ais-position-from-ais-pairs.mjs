import { readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);

const inputPath = process.argv[2]
  ? join(process.cwd(), process.argv[2])
  : join(repoRoot, "RUNYOLO_FINALBISMILLAH", "new", "metadata", "metadata_with_vv_vh_gfw_ais_identity_sog_cog_enriched.csv");

const parsedInput = parsePath(inputPath);
const enrichedPath = join(parsedInput.dir, `${parsedInput.base}_ais_position_enriched${parsedInput.ext}`);
const lookupPath = join(parsedInput.dir, `${parsedInput.base}_needs_external_ais_position_lookup${parsedInput.ext}`);
const reportPath = join(parsedInput.dir, `${parsedInput.base}_ais_position_report.txt`);

const csv = readFileSync(inputPath, "utf8");
const { headers, rows } = parseCsv(csv);

const addedColumns = [
  "AIS_Latitude_original",
  "AIS_Longitude_original",
  "ais_position_status",
  "ais_position_source",
  "ais_position_source_fields",
  "ais_position_formula",
  "ais_position_scene_timestamp_utc",
  "ais_position_interpolation_ratio",
  "ais_position_time_gap_hours",
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

const sourceFields = [
  "scene",
  "ais_before_timestamp",
  "ais_before_lat",
  "ais_before_lon",
  "ais_after_timestamp",
  "ais_after_lat",
  "ais_after_lon",
].join("|");

const lookupRows = [];
let alreadyPresent = 0;
let filled = 0;
let needsLookup = 0;
let invalidPairs = 0;
let sceneOutsidePair = 0;

const outputRows = rows.map((row) => {
  const out = { ...row };
  const originalLat = value(row.AIS_Latitude);
  const originalLon = value(row.AIS_Longitude);
  out.AIS_Latitude_original = originalLat;
  out.AIS_Longitude_original = originalLon;

  const sceneTime = parseDate(sceneTimestamp(row));
  out.ais_position_scene_timestamp_utc = sceneTime ? sceneTime.toISOString() : "";

  if (originalLat && originalLon) {
    alreadyPresent += 1;
    out.ais_position_status = "already_present";
    out.ais_position_source = "existing_AIS_Latitude_AIS_Longitude_columns";
    out.ais_position_source_fields = "AIS_Latitude|AIS_Longitude";
    out.ais_position_formula = "";
    out.ais_position_interpolation_ratio = "";
    out.ais_position_time_gap_hours = "";
    return out;
  }

  const pair = readAisPair(row);
  if (pair.ok && sceneTime) {
    const totalMs = pair.afterTime.getTime() - pair.beforeTime.getTime();
    const ratio = (sceneTime.getTime() - pair.beforeTime.getTime()) / totalMs;
    const hours = totalMs / 3_600_000;

    if (ratio >= 0 && ratio <= 1) {
      const lat = pair.beforeLat + ratio * (pair.afterLat - pair.beforeLat);
      const lon = pair.beforeLon + ratio * (pair.afterLon - pair.beforeLon);

      out.AIS_Latitude = formatNumber(lat, 8);
      out.AIS_Longitude = formatNumber(lon, 8);
      out.ais_position_status = "filled_by_time_interpolation_from_ais_before_after";
      out.ais_position_source = `derived_from_${relative(repoRoot, inputPath)}`;
      out.ais_position_source_fields = sourceFields;
      out.ais_position_formula = "AIS_lat_lon_at_scene=linear_time_interpolation_between_ais_before_and_ais_after";
      out.ais_position_interpolation_ratio = formatNumber(ratio, 8);
      out.ais_position_time_gap_hours = formatNumber(hours, 6);
      filled += 1;
      return out;
    }

    sceneOutsidePair += 1;
    markNeedsLookup(out, row, "scene_time_outside_ais_before_after_range");
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

  if (hasAnyPairField) {
    invalidPairs += 1;
    markNeedsLookup(out, row, "invalid_or_incomplete_ais_pair");
  } else {
    needsLookup += 1;
    markNeedsLookup(out, row, "needs_external_ais_lookup");
  }

  return out;
});

writeFileSync(enrichedPath, stringifyCsv(outputHeaders, outputRows), "utf8");
writeFileSync(lookupPath, stringifyCsv(lookupHeaders, lookupRows), "utf8");

const report = [
  "AIS position enrichment report",
  "",
  `Input: ${relative(repoRoot, inputPath)}`,
  `Output: ${relative(repoRoot, enrichedPath)}`,
  `External lookup list: ${relative(repoRoot, lookupPath)}`,
  "",
  `Rows: ${rows.length}`,
  `Already had AIS_Latitude + AIS_Longitude: ${alreadyPresent}`,
  `Filled by interpolation from ais_before/ais_after: ${filled}`,
  `Scene time outside AIS pair range: ${sceneOutsidePair}`,
  `Invalid/incomplete AIS pair: ${invalidPairs}`,
  `Still needs external AIS lookup: ${needsLookup}`,
  "",
  "Method:",
  "- AIS_Latitude and AIS_Longitude are calculated only when a row has two valid timestamped AIS points around the SAR scene time.",
  "- The position is a linear time interpolation between ais_before and ais_after, so it is an estimated AIS position at the SAR scene timestamp.",
  "- Rows without two valid timestamped AIS points are intentionally left blank.",
  "",
  "Source columns used for derived rows:",
  sourceFields,
  "",
  "Recommended external source for remaining rows:",
  "- Global Fishing Watch AIS vessel track / AIS Vessel Presence near each SAR scene timestamp.",
].join("\n");
writeFileSync(reportPath, report, "utf8");

console.log(report);

function markNeedsLookup(out, row, reason) {
  out.ais_position_status = reason;
  out.ais_position_source = "not_filled_no_valid_ais_position_at_scene";
  out.ais_position_source_fields = sourceFields;
  out.ais_position_formula = "requires AIS track points around the SAR scene timestamp";
  out.ais_position_interpolation_ratio = "";
  out.ais_position_time_gap_hours = "";

  lookupRows.push({
    scene: row.scene ?? "",
    scene_timestamp_utc: out.ais_position_scene_timestamp_utc,
    MMSI: row.MMSI ?? row.gfw_ssvid ?? "",
    gfw_vessel_id: row.gfw_vessel_id ?? "",
    gfw_ssvid: row.gfw_ssvid ?? "",
    Name: row.Name ?? row.gfw_name ?? "",
    category: row.category ?? "",
    Center_latitude: row.Center_latitude ?? "",
    Center_longitude: row.Center_longitude ?? "",
    reason,
    recommended_source: "Global Fishing Watch AIS vessel track / AIS Vessel Presence around scene_timestamp_utc",
  });
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

function formatNumber(n, digits) {
  return Number.isFinite(n) ? n.toFixed(digits).replace(/\.?0+$/, "") : "";
}
