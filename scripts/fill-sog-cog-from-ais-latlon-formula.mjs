import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);

const inputPath = process.argv[2]
  ? join(process.cwd(), process.argv[2])
  : join(repoRoot, "new", "metadata", "metadata_with_vv_vh_gfw_ais_identity_sog_cog_enriched_ais_position_enriched.csv");

const outputDir = dirname(inputPath);
const outputPath = join(outputDir, "metadata_with_vh_gfw_ais_identity_sog_cog_enriched_FINAL.csv");
const stillMissingPath = join(outputDir, "still_missing_sog_cog_audit.csv");
const reportPath = join(outputDir, "metadata_with_vh_gfw_ais_identity_sog_cog_enriched_FINAL_report.txt");

const NEAR_ZERO_DISTANCE_M = 5;
const NEAR_STATIONARY_DISTANCE_M = 500;
const NEAR_STATIONARY_SOG_KNOT = 0.1;
const MAX_AIS_TO_SAR_SOG_KNOT = 35;
const MAX_AIS_TO_SAR_COG_DIFF_DEG = 15;
const KNOTS_PER_MPS = 1.94384;
const SOG_COG_FORMULA = "SOG_knot=(haversine_distance_meter/delta_time_second)*1.94384; COG_deg=initial_bearing_degrees_0_360";
const STILL_MISSING_STATUS = "still_missing_no_second_timestamped_ais_point";
const REJECTED_AIS_TO_SAR_STATUS = "still_missing_ais_to_sar_candidate_rejected_implausible";
const STATIONARY_STATUS = "stationary_or_near_zero_displacement";

const { headers, rows } = parseCsv(readFileSync(inputPath, "utf8"));

const addedColumns = [
  "SOG_calc",
  "COG_calc",
  "sog_cog_source",
  "sog_cog_formula",
  "sog_cog_status",
  "distance_m",
  "delta_time_s",
];

const outputHeaders = [...headers];
for (const col of addedColumns) {
  if (!outputHeaders.includes(col)) outputHeaders.push(col);
}

const missingSogBefore = rows.filter((row) => isBlank(row.Sog)).length;
const missingCogBefore = rows.filter((row) => isBlank(row.Cog)).length;
const { pointsByMmsi, currentPointByRowIndex } = buildAisPointIndex(rows);

let alreadyComplete = 0;
let calculatedFromFormula = 0;
let stationaryOrNearZero = 0;
let rejectedAisToSar = 0;
const sourceCounts = new Map();

for (const [rowIndexText, row] of rows.entries()) {
  const rowIndex = Number(rowIndexText);
  const missingSogAtStart = isBlank(row.Sog);
  const missingCogAtStart = isBlank(row.Cog);

  row.SOG_calc = value(row.Sog);
  row.COG_calc = value(row.Cog);
  row.distance_m = "";
  row.delta_time_s = "";

  if (!missingSogAtStart && !missingCogAtStart) {
    alreadyComplete += 1;
    setSogCogAudit(row, "original_ais", "original_ais", "not_calculated_original_ais", "Sog|Cog", null, null);
    bump(sourceCounts, row.sog_cog_source);
    continue;
  }

  const pair = nearestSameMmsiPair(row, rowIndex, pointsByMmsi, currentPointByRowIndex);
  if (pair) {
    const calculation = calculateFromPair(row, rowIndex, pair);
    if (calculation) {
      const filled = fillMissingOnly(row, calculation.sog, calculation.cog, missingSogAtStart, missingCogAtStart);
      row.SOG_calc = value(row.Sog);
      row.COG_calc = value(row.Cog);
      setSogCogAudit(
        row,
        calculation.source,
        calculation.source,
        calculation.formula,
        calculation.sourceFields,
        calculation.distanceM,
        calculation.deltaTimeS,
      );

      if (calculation.source === STATIONARY_STATUS) {
        stationaryOrNearZero += 1;
      } else if (filled) {
        calculatedFromFormula += 1;
      }
    }
  }

  if (hasMissingSogOrCog(row)) {
    const aisToSar = calculateFromAisToSar(row, rowIndex);
    if (aisToSar?.accepted) {
      const filled = fillMissingOnly(row, aisToSar.sog, aisToSar.cog, missingSogAtStart, missingCogAtStart);
      row.SOG_calc = value(row.Sog);
      row.COG_calc = value(row.Cog);
      setSogCogAudit(
        row,
        aisToSar.source,
        aisToSar.status,
        aisToSar.formula,
        aisToSar.sourceFields,
        aisToSar.distanceM,
        aisToSar.deltaTimeS,
      );
      if (aisToSar.status === STATIONARY_STATUS) stationaryOrNearZero += 1;
      if (filled) calculatedFromFormula += 1;
    } else if (aisToSar?.rejected) {
      rejectedAisToSar += 1;
      setSogCogAudit(
        row,
        aisToSar.source,
        aisToSar.status,
        aisToSar.formula,
        aisToSar.sourceFields,
        aisToSar.distanceM,
        aisToSar.deltaTimeS,
      );
    }
  }

  if (hasMissingSogOrCog(row)) {
    row.SOG_calc = value(row.Sog);
    row.COG_calc = value(row.Cog);
    if (row.sog_cog_status !== STATIONARY_STATUS && row.sog_cog_status !== REJECTED_AIS_TO_SAR_STATUS) {
      setSogCogAudit(
        row,
        STILL_MISSING_STATUS,
        STILL_MISSING_STATUS,
        "requires at least two valid AIS positions with different timestamps; value left blank",
        "MMSI|AIS_Latitude|AIS_Longitude|timestamp",
        null,
        null,
      );
    }
  }

  bump(sourceCounts, row.sog_cog_source);
}

const missingRows = rows.filter(hasMissingSogOrCog);
const missingSogAfter = rows.filter((row) => isBlank(row.Sog)).length;
const missingCogAfter = rows.filter((row) => isBlank(row.Cog)).length;
const stillMissingByStatus = countBy(missingRows, (row) => row.sog_cog_status || STILL_MISSING_STATUS);
writeFileSync(outputPath, stringifyCsv(outputHeaders, rows), "utf8");
writeFileSync(stillMissingPath, stringifyCsv(outputHeaders, missingRows), "utf8");

const report = [
  "AIS/SAR SOG/COG final enrichment report",
  "",
  `Input: ${relative(repoRoot, inputPath)}`,
  `Output: ${relative(repoRoot, outputPath)}`,
  `Still missing audit: ${relative(repoRoot, stillMissingPath)}`,
  "",
  `Rows: ${rows.length}`,
  `Jumlah SOG kosong sebelum: ${missingSogBefore}`,
  `Jumlah COG kosong sebelum: ${missingCogBefore}`,
  `Jumlah SOG kosong sesudah: ${missingSogAfter}`,
  `Jumlah COG kosong sesudah: ${missingCogAfter}`,
  `Jumlah berhasil dihitung dari rumus: ${calculatedFromFormula}`,
  `Jumlah stationary/near-zero displacement: ${stationaryOrNearZero}`,
  `Jumlah kandidat AIS-to-SAR ditolak karena tidak plausible: ${rejectedAisToSar}`,
  `Jumlah tetap kosong: ${missingRows.length}`,
  `Already complete SOG+COG: ${alreadyComplete}`,
  "",
  "Tetap kosong dan alasannya:",
  ...formatCountLines(stillMissingByStatus),
  "",
  "Source counts:",
  ...formatCountLines(sourceCounts),
  "",
  "Rules:",
  "- Existing Sog/Cog values are preserved.",
  "- Missing values are calculated only from valid same-MMSI AIS coordinate pairs with different timestamps.",
  "- If same-MMSI AIS pairs are unavailable, AIS-to-SAR detection is used only when speed and bearing pass plausibility checks.",
  "- Pair priority is previous same-MMSI point, then next same-MMSI point, then nearest bracketing pair.",
  "- Distance uses Haversine. COG uses initial bearing in degrees 0-360.",
  "- Rows without a second timestamped AIS point are left blank.",
].join("\n");

writeFileSync(reportPath, report, "utf8");
console.log(report);

function buildAisPointIndex(inputRows) {
  const indexByMmsi = new Map();
  const currentByRow = new Map();

  for (const [rowIndexText, row] of inputRows.entries()) {
    const rowIndex = Number(rowIndexText);
    const current = pointFromCurrentRow(row, rowIndex);
    if (current) {
      addPoint(indexByMmsi, current);
      currentByRow.set(rowIndex, current);
    }

    const before = pointFromExplicitFields(row, rowIndex, "ais_before");
    if (before) addPoint(indexByMmsi, before);

    const after = pointFromExplicitFields(row, rowIndex, "ais_after");
    if (after) addPoint(indexByMmsi, after);
  }

  for (const points of indexByMmsi.values()) {
    points.sort((a, b) => a.time - b.time || a.rowIndex - b.rowIndex);
  }

  return { pointsByMmsi: indexByMmsi, currentPointByRowIndex: currentByRow };
}

function pointFromCurrentRow(row, rowIndex) {
  const mmsi = value(row.MMSI);
  const lat = number(row.AIS_Latitude);
  const lon = number(row.AIS_Longitude);
  const timestamp = bestCurrentTimestamp(row);
  if (!mmsi || !finiteLatLon(lat, lon) || !timestamp) return null;
  return { mmsi, rowIndex, row, role: "current", time: timestamp.time, timeSource: timestamp.source, lat, lon };
}

function pointFromExplicitFields(row, rowIndex, prefix) {
  const mmsi = value(row.MMSI);
  const lat = number(row[`${prefix}_lat`]);
  const lon = number(row[`${prefix}_lon`]);
  const time = parseDateish(row[`${prefix}_timestamp`]);
  if (!mmsi || !finiteLatLon(lat, lon) || !time) return null;
  return { mmsi, rowIndex, row, role: prefix, time, timeSource: `${prefix}_timestamp`, lat, lon };
}

function addPoint(indexByMmsi, point) {
  if (!indexByMmsi.has(point.mmsi)) indexByMmsi.set(point.mmsi, []);
  indexByMmsi.get(point.mmsi).push(point);
}

function bestCurrentTimestamp(row) {
  const fieldOrder = [
    "AIS_update_datetime",
    "AIS_Timestamp",
    "AIS_timestamp",
    "AIS_Time",
    "AIS_time",
    "Detection_Time",
    "DetectionTime",
    "detection_time",
    "timestamp",
    "Timestamp",
    "sog_cog_scene_timestamp_utc",
    "ais_position_scene_timestamp_utc",
    "gfw_sar_bearing_timestamp",
  ];

  for (const field of fieldOrder) {
    const parsed = parseDateish(row[field]);
    if (parsed) return { time: parsed, source: field };
  }

  const fromScene = sceneTimestamp(row);
  return fromScene ? { time: fromScene, source: "scene" } : null;
}

function nearestSameMmsiPair(row, rowIndex, indexByMmsi, currentByRow) {
  const mmsi = value(row.MMSI);
  const points = indexByMmsi.get(mmsi) ?? [];
  const currentPoint = currentByRow.get(rowIndex);
  const currentTime = currentPoint?.time ?? bestCurrentTimestamp(row)?.time;
  if (!currentTime || points.length < 2) return null;

  let previous = null;
  let next = null;
  for (const point of points) {
    if (point.rowIndex === rowIndex && point.role === "current") continue;
    if (point.time < currentTime) previous = point;
    if (point.time > currentTime && !next) next = point;
  }

  if (previous && currentPoint) {
    const pair = makePair(previous, currentPoint, "calculated_from_previous_same_mmsi");
    if (validPair(pair)) return pair;
  }

  if (next && currentPoint) {
    const pair = makePair(currentPoint, next, "calculated_from_next_same_mmsi");
    if (validPair(pair)) return pair;
  }

  if (previous && next) {
    const pair = makePair(previous, next, "calculated_from_nearest_pair_same_mmsi");
    if (validPair(pair)) return pair;
  }

  return null;
}

function makePair(from, to, source) {
  return { from, to, source };
}

function validPair(pair) {
  return pair && pair.to.time > pair.from.time;
}

function calculateFromPair(row, rowIndex, pair) {
  const deltaTimeS = (pair.to.time - pair.from.time) / 1000;
  if (!(deltaTimeS > 0)) return null;

  const distanceM = haversineM(pair.from.lat, pair.from.lon, pair.to.lat, pair.to.lon);
  if (!Number.isFinite(distanceM)) return null;

  const sourceFields = [
    "MMSI",
    `${pair.from.role}:${pair.from.timeSource}:lat:lon`,
    `${pair.to.role}:${pair.to.timeSource}:lat:lon`,
  ].join("|");

  if (distanceM < NEAR_ZERO_DISTANCE_M) {
    const cog = sameMmsiCogFallback(row, rowIndex, pair.from.mmsi);
    return {
      source: STATIONARY_STATUS,
      sog: 0,
      cog,
      distanceM,
      deltaTimeS,
      sourceFields,
      formula: `${SOG_COG_FORMULA}; near_zero_threshold_meter=${NEAR_ZERO_DISTANCE_M}; SOG_calc=0; COG_calc=original_or_same_mmsi_COG_if_available`,
    };
  }

  return {
    source: pair.source,
    sog: (distanceM / deltaTimeS) * KNOTS_PER_MPS,
    cog: initialBearing(pair.from.lat, pair.from.lon, pair.to.lat, pair.to.lon),
    distanceM,
    deltaTimeS,
    sourceFields,
    formula: SOG_COG_FORMULA,
  };
}

function calculateFromAisToSar(row, rowIndex) {
  const aisPoint = pointFromCurrentRow(row, rowIndex);
  const sarPoint = pointFromSarDetection(row, rowIndex);
  if (!aisPoint || !sarPoint) return null;

  const deltaTimeS = Math.abs(sarPoint.time - aisPoint.time) / 1000;
  if (!(deltaTimeS > 0)) return null;

  const distanceM = haversineM(aisPoint.lat, aisPoint.lon, sarPoint.lat, sarPoint.lon);
  if (!Number.isFinite(distanceM)) return null;

  const from = aisPoint.time <= sarPoint.time ? aisPoint : sarPoint;
  const to = aisPoint.time <= sarPoint.time ? sarPoint : aisPoint;
  const sog = (distanceM / deltaTimeS) * KNOTS_PER_MPS;
  const cog = distanceM >= NEAR_ZERO_DISTANCE_M
    ? initialBearing(from.lat, from.lon, to.lat, to.lon)
    : sameMmsiCogFallback(row, rowIndex, value(row.MMSI));

  const existingOrReferenceCog = firstFiniteNumber(row.Cog, row.Cog_original, row.gfw_sar_bearing);
  const cogDifference = Number.isFinite(existingOrReferenceCog) && Number.isFinite(cog)
    ? angleDifference(cog, existingOrReferenceCog)
    : NaN;

  const sourceFields = [
    "MMSI",
    `AIS:${aisPoint.timeSource}:AIS_Latitude:AIS_Longitude`,
    `SAR:${sarPoint.timeSource}:Center_latitude:Center_longitude`,
    "reference_COG=Cog|Cog_original|gfw_sar_bearing",
  ].join("|");

  if (sog <= NEAR_STATIONARY_SOG_KNOT && distanceM <= NEAR_STATIONARY_DISTANCE_M) {
    return {
      accepted: true,
      source: "calculated_from_ais_to_sar_detection",
      status: STATIONARY_STATUS,
      sog: 0,
      cog: sameMmsiCogFallback(row, rowIndex, value(row.MMSI)),
      distanceM,
      deltaTimeS,
      sourceFields,
      formula: `${SOG_COG_FORMULA}; AIS-to-SAR fallback; near_stationary_speed_knot<=${NEAR_STATIONARY_SOG_KNOT}; near_stationary_distance_m<=${NEAR_STATIONARY_DISTANCE_M}; COG left blank unless original/same-MMSI COG exists`,
    };
  }

  const speedLooksPlausible = sog <= MAX_AIS_TO_SAR_SOG_KNOT;
  const bearingLooksPlausible = !Number.isFinite(cogDifference) || cogDifference <= MAX_AIS_TO_SAR_COG_DIFF_DEG;
  if (speedLooksPlausible && bearingLooksPlausible) {
    return {
      accepted: true,
      source: "calculated_from_ais_to_sar_detection",
      status: "calculated_from_ais_to_sar_detection",
      sog,
      cog,
      distanceM,
      deltaTimeS,
      sourceFields,
      formula: `${SOG_COG_FORMULA}; AIS-to-SAR fallback; accepted if SOG<=${MAX_AIS_TO_SAR_SOG_KNOT} knot and COG/reference difference<=${MAX_AIS_TO_SAR_COG_DIFF_DEG} deg when reference exists`,
    };
  }

  const rejectReasons = [];
  if (!speedLooksPlausible) rejectReasons.push(`candidate_sog_${formatNumber(sog, 3)}_gt_${MAX_AIS_TO_SAR_SOG_KNOT}_knot`);
  if (!bearingLooksPlausible) rejectReasons.push(`candidate_cog_reference_diff_${formatNumber(cogDifference, 3)}_gt_${MAX_AIS_TO_SAR_COG_DIFF_DEG}_deg`);

  return {
    rejected: true,
    source: "ais_to_sar_detection_candidate_rejected",
    status: REJECTED_AIS_TO_SAR_STATUS,
    distanceM,
    deltaTimeS,
    sourceFields,
    formula: `${SOG_COG_FORMULA}; rejected ${rejectReasons.join("; ")}; candidate_SOG_knot=${formatNumber(sog, 6)}; candidate_COG_deg=${formatAngle(cog)}`,
  };
}

function pointFromSarDetection(row, rowIndex) {
  const mmsi = value(row.MMSI);
  const lat = number(row.Center_latitude);
  const lon = number(row.Center_longitude);
  const time = sceneTimestamp(row) ?? parseDateish(row.gfw_sar_bearing_timestamp);
  if (!mmsi || !finiteLatLon(lat, lon) || !time) return null;
  return { mmsi, rowIndex, row, role: "sar_detection", time, timeSource: "scene|gfw_sar_bearing_timestamp", lat, lon };
}

function sameMmsiCogFallback(row, rowIndex, mmsi) {
  const ownCog = firstFiniteNumber(row.Cog, row.Cog_original);
  if (Number.isFinite(ownCog)) return normalizeAngle(ownCog);

  const currentTime = bestCurrentTimestamp(row)?.time;
  let best = null;
  for (const [candidateIndexText, candidate] of rows.entries()) {
    const candidateIndex = Number(candidateIndexText);
    if (candidateIndex === rowIndex || value(candidate.MMSI) !== mmsi) continue;
    const cog = firstFiniteNumber(candidate.Cog, candidate.Cog_original);
    if (!Number.isFinite(cog)) continue;
    const candidateTime = bestCurrentTimestamp(candidate)?.time;
    const gap = currentTime && candidateTime ? Math.abs(candidateTime - currentTime) : 0;
    if (!best || gap < best.gap) best = { cog, gap };
  }

  return best ? normalizeAngle(best.cog) : NaN;
}

function fillMissingOnly(row, sog, cog, missingSogAtStart, missingCogAtStart) {
  let filled = false;
  if (missingSogAtStart && isBlank(row.Sog) && Number.isFinite(sog)) {
    row.Sog = formatNumber(sog, 6);
    filled = true;
  }
  if (missingCogAtStart && isBlank(row.Cog) && Number.isFinite(cog)) {
    row.Cog = formatAngle(cog);
    filled = true;
  }
  return filled;
}

function setSogCogAudit(row, source, status, formula, sourceFields, distanceM, deltaTimeS) {
  row.sog_cog_source = source;
  row.sog_cog_status = status;
  row.sog_cog_formula = formula;
  row.sog_cog_source_fields = sourceFields;
  row.distance_m = Number.isFinite(distanceM) ? formatNumber(distanceM, 3) : "";
  row.delta_time_s = Number.isFinite(deltaTimeS) ? formatNumber(deltaTimeS, 3) : "";
  row.sog_cog_distance_km = Number.isFinite(distanceM) ? formatNumber(distanceM / 1000, 6) : "";
  row.sog_cog_time_hours = Number.isFinite(deltaTimeS) ? formatNumber(deltaTimeS / 3600, 6) : "";
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
  if (!Number.isNaN(date.getTime())) return date;

  const fromScene = raw.match(/(\d{8}T\d{6})/);
  if (!fromScene) return null;
  const s = fromScene[1];
  const sceneDate = new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}Z`);
  return Number.isNaN(sceneDate.getTime()) ? null : sceneDate;
}

function haversineM(lat1, lon1, lat2, lon2) {
  return haversineKm(lat1, lon1, lat2, lon2) * 1000;
}

function firstFiniteNumber(...inputs) {
  for (const input of inputs) {
    const n = number(input);
    if (Number.isFinite(n)) return n;
  }
  return NaN;
}

function normalizeAngle(deg) {
  return ((deg % 360) + 360) % 360;
}

function angleDifference(a, b) {
  const diff = Math.abs(normalizeAngle(a) - normalizeAngle(b)) % 360;
  return diff > 180 ? 360 - diff : diff;
}

function countBy(items, keyFn) {
  const counts = new Map();
  for (const item of items) bump(counts, keyFn(item));
  return counts;
}

function bump(map, key) {
  const normalized = value(key) || "(blank)";
  map.set(normalized, (map.get(normalized) ?? 0) + 1);
}

function formatCountLines(counts) {
  if (!counts.size) return ["- none"];
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key, count]) => `- ${key}: ${count}`);
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
