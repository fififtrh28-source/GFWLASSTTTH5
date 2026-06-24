import { readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);

const inputPath = process.argv[2]
  ? join(process.cwd(), process.argv[2])
  : join(repoRoot, "new", "metadata", "metadata_with_vv_vh_gfw_ais_identity_sog_cog_enriched_ais_position_enriched.csv");

const parsed = parsePath(inputPath);
const outputPath = join(parsed.dir, `${parsed.base}_ais_latlon_formula_filled${parsed.ext}`);
const stillMissingPath = join(parsed.dir, `${parsed.base}_ais_latlon_formula_still_missing_sog_cog${parsed.ext}`);
const reportPath = join(parsed.dir, `${parsed.base}_ais_latlon_formula_report.txt`);

const { headers, rows } = parseCsv(readFileSync(inputPath, "utf8"));

const addedColumns = [
  "Sog_before_ais_latlon_formula",
  "Cog_before_ais_latlon_formula",
  "ais_latlon_formula_status",
  "ais_latlon_formula_source",
  "ais_latlon_formula_note",
  "ais_latlon_formula_neighbor_scene",
  "ais_latlon_formula_time_gap_hours",
  "ais_latlon_formula_distance_km",
];

const outputHeaders = [...headers];
for (const col of addedColumns) {
  if (!outputHeaders.includes(col)) outputHeaders.push(col);
}

const pointsByMmsi = new Map();
for (const row of rows) {
  const mmsi = value(row.MMSI);
  const sceneTime = sceneTimestamp(row);
  const lat = number(row.AIS_Latitude);
  const lon = number(row.AIS_Longitude);
  if (!mmsi || !sceneTime || !finiteLatLon(lat, lon)) continue;
  if (!pointsByMmsi.has(mmsi)) pointsByMmsi.set(mmsi, []);
  pointsByMmsi.get(mmsi).push({ row, sceneTime, lat, lon });
}

for (const points of pointsByMmsi.values()) {
  points.sort((a, b) => a.sceneTime - b.sceneTime);
}

let alreadyComplete = 0;
let filledFromBeforeAfter = 0;
let filledStationaryCog = 0;
let filledFromSameMmsiScene = 0;
let stillMissing = 0;

for (const row of rows) {
  row.Sog_before_ais_latlon_formula = value(row.Sog);
  row.Cog_before_ais_latlon_formula = value(row.Cog);
  row.ais_latlon_formula_neighbor_scene = "";
  row.ais_latlon_formula_time_gap_hours = "";
  row.ais_latlon_formula_distance_km = "";

  if (!hasMissingSogOrCog(row)) {
    alreadyComplete += 1;
    row.ais_latlon_formula_status = "already_complete";
    row.ais_latlon_formula_source = "existing_Sog_Cog";
    row.ais_latlon_formula_note = "";
    continue;
  }

  const beforeAfter = computeFromBeforeAfter(row);
  if (beforeAfter) {
    fillMissing(row, beforeAfter.sog, beforeAfter.cog);
    row.ais_latlon_formula_status = "filled_from_ais_before_after_formula";
    row.ais_latlon_formula_source = "ais_before_timestamp|ais_before_lat|ais_before_lon|ais_after_timestamp|ais_after_lat|ais_after_lon";
    row.ais_latlon_formula_note = "Computed with SOG = distance/time and COG = initial bearing from AIS before point to AIS after point.";
    row.ais_latlon_formula_time_gap_hours = formatNumber(beforeAfter.hours, 6);
    row.ais_latlon_formula_distance_km = formatNumber(beforeAfter.distanceKm, 6);
    markSogCogProvenance(
      row,
      "filled_from_ais_before_after_formula",
      "ais_before_after_columns",
      "ais_before_timestamp|ais_before_lat|ais_before_lon|ais_after_timestamp|ais_after_lat|ais_after_lon",
      "SOG_knots=haversine_distance_km/1.852/time_gap_hours; COG_deg=initial_bearing_ais_before_to_ais_after",
      beforeAfter.distanceKm,
      beforeAfter.hours,
    );
    filledFromBeforeAfter += 1;
  }

  if (hasMissingSogOrCog(row) && isBlank(row.Cog) && !isBlank(row.Sog) && number(row.Sog) === 0) {
    row.Cog = "0";
    row.ais_latlon_formula_status = "filled_stationary_cog_placeholder";
    row.ais_latlon_formula_source = "existing_Sog_equals_0";
    row.ais_latlon_formula_note = "COG is not physically meaningful when SOG is 0; filled with 0 for computational consistency.";
    markSogCogProvenance(
      row,
      "filled_stationary_cog_placeholder",
      "existing_Sog_equals_0",
      "Sog",
      "COG_deg=0 placeholder because SOG is 0 and course is physically undefined",
      null,
      null,
    );
    filledStationaryCog += 1;
  }

  if (hasMissingSogOrCog(row)) {
    const interScene = computeFromSameMmsiScene(row);
    if (interScene) {
      fillMissing(row, interScene.sog, interScene.cog);
      row.ais_latlon_formula_status = "filled_from_same_mmsi_ais_latlon_inter_scene";
      row.ais_latlon_formula_source = "AIS_Latitude|AIS_Longitude from same MMSI in another SAR scene";
      row.ais_latlon_formula_note = "Computed from two AIS positions of the same MMSI in this dataset. This is an inter-scene average estimate, not an observed onboard AIS SOG/COG at the scene timestamp.";
      row.ais_latlon_formula_neighbor_scene = interScene.neighborScene;
      row.ais_latlon_formula_time_gap_hours = formatNumber(interScene.hours, 6);
      row.ais_latlon_formula_distance_km = formatNumber(interScene.distanceKm, 6);
      markSogCogProvenance(
        row,
        "filled_from_same_mmsi_ais_latlon_inter_scene",
        "same_mmsi_ais_latlon_inter_scene",
        "MMSI|scene|AIS_Latitude|AIS_Longitude",
        "SOG_knots=haversine_distance_km/1.852/time_gap_hours; COG_deg=initial_bearing_between_same_MMSI_scene_points",
        interScene.distanceKm,
        interScene.hours,
      );
      filledFromSameMmsiScene += 1;
    }
  }

  if (hasMissingSogOrCog(row)) {
    stillMissing += 1;
    if (!row.ais_latlon_formula_status) {
      row.ais_latlon_formula_status = "still_missing_no_second_timestamped_ais_point";
      row.ais_latlon_formula_source = "not_filled";
      row.ais_latlon_formula_note = "Only one AIS position is available for this row/MMSI, so SOG/COG cannot be computed from AIS lat/lon without inventing another point.";
    }
  }
}

const missingRows = rows.filter(hasMissingSogOrCog);
writeFileSync(outputPath, stringifyCsv(outputHeaders, rows), "utf8");
writeFileSync(stillMissingPath, stringifyCsv(outputHeaders, missingRows), "utf8");

const report = [
  "AIS lat/lon SOG/COG formula fill report",
  "",
  `Input: ${relative(repoRoot, inputPath)}`,
  `Output: ${relative(repoRoot, outputPath)}`,
  `Still missing list: ${relative(repoRoot, stillMissingPath)}`,
  "",
  `Rows: ${rows.length}`,
  `Already complete SOG+COG: ${alreadyComplete}`,
  `Filled from AIS before/after formula: ${filledFromBeforeAfter}`,
  `Filled stationary COG placeholder where SOG=0: ${filledStationaryCog}`,
  `Filled from same-MMSI AIS lat/lon inter-scene formula: ${filledFromSameMmsiScene}`,
  `Still missing after formula attempt: ${missingRows.length}`,
  "",
  "Formulas:",
  "- SOG(knots) = haversine_distance_km / 1.852 / time_gap_hours",
  "- COG(degrees) = initial bearing from point 1 to point 2",
  "",
  "Rules:",
  "- A single AIS_Latitude/AIS_Longitude point cannot produce SOG/COG.",
  "- The preferred source is ais_before/ais_after because it brackets the SAR scene time.",
  "- Same-MMSI inter-scene estimates are marked as estimates because the time gap can be hours or days.",
  "- Rows without a second timestamped AIS point are left blank.",
].join("\n");

writeFileSync(reportPath, report, "utf8");
console.log(report);

function computeFromBeforeAfter(row) {
  const t0 = parseDate(row.ais_before_timestamp);
  const t1 = parseDate(row.ais_after_timestamp);
  const lat0 = number(row.ais_before_lat);
  const lon0 = number(row.ais_before_lon);
  const lat1 = number(row.ais_after_lat);
  const lon1 = number(row.ais_after_lon);
  if (!t0 || !t1 || !finiteLatLon(lat0, lon0) || !finiteLatLon(lat1, lon1)) return null;
  const hours = (t1 - t0) / 3_600_000;
  if (!(hours > 0)) return null;
  const distanceKm = haversineKm(lat0, lon0, lat1, lon1);
  return {
    sog: (distanceKm / 1.852) / hours,
    cog: distanceKm > 1e-9 ? initialBearing(lat0, lon0, lat1, lon1) : 0,
    hours,
    distanceKm,
  };
}

function computeFromSameMmsiScene(row) {
  const mmsi = value(row.MMSI);
  const sceneTime = sceneTimestamp(row);
  const lat = number(row.AIS_Latitude);
  const lon = number(row.AIS_Longitude);
  if (!mmsi || !sceneTime || !finiteLatLon(lat, lon)) return null;

  const points = pointsByMmsi.get(mmsi) ?? [];
  let best = null;
  for (const point of points) {
    if (point.row === row) continue;
    const hoursAbs = Math.abs(point.sceneTime - sceneTime) / 3_600_000;
    if (!(hoursAbs > 0)) continue;
    if (!best || hoursAbs < best.hoursAbs) best = { ...point, hoursAbs };
  }
  if (!best) return null;

  const before = best.sceneTime < sceneTime
    ? { lat: best.lat, lon: best.lon, time: best.sceneTime, scene: value(best.row.scene) }
    : { lat, lon, time: sceneTime, scene: value(row.scene) };
  const after = best.sceneTime < sceneTime
    ? { lat, lon, time: sceneTime, scene: value(row.scene) }
    : { lat: best.lat, lon: best.lon, time: best.sceneTime, scene: value(best.row.scene) };

  const hours = (after.time - before.time) / 3_600_000;
  if (!(hours > 0)) return null;
  const distanceKm = haversineKm(before.lat, before.lon, after.lat, after.lon);
  return {
    sog: (distanceKm / 1.852) / hours,
    cog: distanceKm > 1e-9 ? initialBearing(before.lat, before.lon, after.lat, after.lon) : 0,
    hours,
    distanceKm,
    neighborScene: value(best.row.scene),
  };
}

function fillMissing(row, sog, cog) {
  if (isBlank(row.Sog) && Number.isFinite(sog)) row.Sog = formatNumber(sog, 6);
  if (isBlank(row.Cog) && Number.isFinite(cog)) row.Cog = formatAngle(cog);
}

function markSogCogProvenance(row, status, source, sourceFields, formula, distanceKm, hours) {
  row.sog_cog_status = status;
  row.sog_cog_source = source;
  row.sog_cog_source_fields = sourceFields;
  row.sog_cog_formula = formula;
  row.sog_cog_distance_km = Number.isFinite(distanceKm) ? formatNumber(distanceKm, 6) : "";
  row.sog_cog_time_hours = Number.isFinite(hours) ? formatNumber(hours, 6) : "";
}

function parsePath(path) {
  const ext = extname(path);
  return {
    dir: dirname(path),
    base: path.slice(dirname(path).length + 1, path.length - ext.length),
    ext,
  };
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
      allRows.push(row);
      row = [];
      field = "";
    } else if (ch !== "\r") {
      field += ch;
    }
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

function escapeCsv(value) {
  const s = String(value ?? "");
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

function parseDate(input) {
  const raw = value(input);
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

function sceneTimestamp(row) {
  const fromScene = value(row.scene).match(/(\d{8}T\d{6})/);
  if (fromScene) {
    const s = fromScene[1];
    return new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}Z`);
  }
  return null;
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

function formatNumber(input, digits) {
  return Number.isFinite(input) ? input.toFixed(digits).replace(/\.?0+$/, "") : "";
}

function formatAngle(input) {
  if (!Number.isFinite(input)) return "";
  return formatNumber(((input % 360) + 360) % 360, 6);
}
