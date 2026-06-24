import { readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);

const inputPath = process.argv[2]
  ? join(process.cwd(), process.argv[2])
  : join(repoRoot, "new", "metadata", "metadata_with_vv_vh_gfw_ais_identity_sog_cog_enriched_ais_position_enriched_ais_latlon_formula_filled.csv");

const parsed = parsePath(inputPath);
const outputPath = join(parsed.dir, `${parsed.base}_kalman_estimated${parsed.ext}`);
const reportPath = join(parsed.dir, `${parsed.base}_kalman_report.txt`);

const { headers, rows } = parseCsv(readFileSync(inputPath, "utf8"));

const addedColumns = [
  "kalman_status",
  "kalman_note",
  "kalman_scene_timestamp_utc",
  "kalman_mmsi_observation_count",
  "kalman_sequence_index",
  "kalman_dt_hours",
  "kalman_position_measurement_source",
  "kalman_velocity_measurement_used",
  "kalman_velocity_measurement_source",
  "kalman_pred_lat",
  "kalman_pred_lon",
  "kalman_est_lat",
  "kalman_est_lon",
  "kalman_est_sog",
  "kalman_est_cog",
  "kalman_pred_residual_m",
  "kalman_est_position_sigma_m",
  "kalman_est_velocity_sigma_mps",
  "kalman_model",
  "kalman_process_acceleration_sigma_mps2",
  "kalman_position_measurement_sigma_m",
  "kalman_velocity_measurement_sigma_mps",
];

const outputHeaders = [...headers];
for (const col of addedColumns) {
  if (!outputHeaders.includes(col)) outputHeaders.push(col);
}

const processAccelerationSigma = 0.02;
const positionMeasurementSigma = 250;

const validRows = rows
  .map((row, index) => ({ row, index, time: sceneTimestamp(row), lat: number(row.AIS_Latitude), lon: number(row.AIS_Longitude) }))
  .filter((item) => value(item.row.MMSI) && item.time && finiteLatLon(item.lat, item.lon));

const groups = new Map();
for (const item of validRows) {
  const mmsi = value(item.row.MMSI);
  if (!groups.has(mmsi)) groups.set(mmsi, []);
  groups.get(mmsi).push(item);
}

for (const group of groups.values()) {
  group.sort((a, b) => a.time - b.time || a.index - b.index);
}

let rowsWithPosition = 0;
let rowsWithVelocity = 0;
let rowsWithoutVelocity = 0;
let initialized = 0;
let predictedAndUpdated = 0;
let positionOnly = 0;
let skipped = 0;
const residuals = [];

for (const row of rows) {
  row.kalman_status = "skipped_missing_required_position_or_time";
  row.kalman_note = "Missing MMSI, scene timestamp, AIS_Latitude, or AIS_Longitude.";
  row.kalman_scene_timestamp_utc = "";
  row.kalman_mmsi_observation_count = "";
  row.kalman_sequence_index = "";
  row.kalman_dt_hours = "";
  row.kalman_position_measurement_source = "";
  row.kalman_velocity_measurement_used = "false";
  row.kalman_velocity_measurement_source = "";
  row.kalman_pred_lat = "";
  row.kalman_pred_lon = "";
  row.kalman_est_lat = "";
  row.kalman_est_lon = "";
  row.kalman_est_sog = "";
  row.kalman_est_cog = "";
  row.kalman_pred_residual_m = "";
  row.kalman_est_position_sigma_m = "";
  row.kalman_est_velocity_sigma_mps = "";
  row.kalman_model = "constant_velocity_xy";
  row.kalman_process_acceleration_sigma_mps2 = formatNumber(processAccelerationSigma, 6);
  row.kalman_position_measurement_sigma_m = formatNumber(positionMeasurementSigma, 3);
  row.kalman_velocity_measurement_sigma_mps = "";
}

for (const [mmsi, group] of groups) {
  const refLat = group[0].lat;
  const refLon = group[0].lon;
  let state = null;
  let covariance = null;
  let previousTime = null;

  for (let i = 0; i < group.length; i += 1) {
    const item = group[i];
    const row = item.row;
    rowsWithPosition += 1;

    const position = projectToMeters(item.lat, item.lon, refLat, refLon);
    const velocity = velocityMeasurement(row);
    if (velocity) rowsWithVelocity += 1;
    else rowsWithoutVelocity += 1;

    row.kalman_scene_timestamp_utc = item.time.toISOString();
    row.kalman_mmsi_observation_count = String(group.length);
    row.kalman_sequence_index = String(i + 1);
    row.kalman_position_measurement_source = "AIS_Latitude|AIS_Longitude";
    row.kalman_velocity_measurement_used = velocity ? "true" : "false";
    row.kalman_velocity_measurement_source = velocity?.source ?? "not_used_missing_Sog_or_Cog";

    if (!state) {
      state = [
        position.x,
        position.y,
        velocity?.vx ?? 0,
        velocity?.vy ?? 0,
      ];
      covariance = diag([
        positionMeasurementSigma ** 2,
        positionMeasurementSigma ** 2,
        velocity ? velocity.sigma ** 2 : 100 ** 2,
        velocity ? velocity.sigma ** 2 : 100 ** 2,
      ]);

      let updated = updatePosition(state, covariance, position.x, position.y);
      state = updated.state;
      covariance = updated.covariance;
      if (velocity) {
        updated = updateVelocity(state, covariance, velocity.vx, velocity.vy, velocity.sigma);
        state = updated.state;
        covariance = updated.covariance;
      }

      const latLon = unprojectFromMeters(state[0], state[1], refLat, refLon);
      writeEstimate(row, latLon, state, covariance);
      row.kalman_status = velocity ? "initialized_with_position_and_velocity" : "initialized_position_only";
      row.kalman_note = velocity
        ? "First observation for this MMSI; initialized from AIS position and available SOG/COG."
        : "First observation for this MMSI; no SOG/COG was available, so velocity output is left blank instead of inventing speed/course.";
      if (!velocity) {
        row.kalman_est_sog = "";
        row.kalman_est_cog = "";
        row.kalman_est_velocity_sigma_mps = "";
      }
      initialized += 1;
      if (!velocity) positionOnly += 1;
      previousTime = item.time;
      continue;
    }

    const dtSeconds = Math.max(0, (item.time - previousTime) / 1000);
    row.kalman_dt_hours = formatNumber(dtSeconds / 3600, 6);

    const predicted = predict(state, covariance, dtSeconds);
    const predLatLon = unprojectFromMeters(predicted.state[0], predicted.state[1], refLat, refLon);
    row.kalman_pred_lat = formatNumber(predLatLon.lat, 8);
    row.kalman_pred_lon = formatNumber(predLatLon.lon, 8);
    const residualM = Math.hypot(position.x - predicted.state[0], position.y - predicted.state[1]);
    row.kalman_pred_residual_m = formatNumber(residualM, 3);
    residuals.push(residualM);

    let updated = updatePosition(predicted.state, predicted.covariance, position.x, position.y);
    state = updated.state;
    covariance = updated.covariance;
    if (velocity) {
      updated = updateVelocity(state, covariance, velocity.vx, velocity.vy, velocity.sigma);
      state = updated.state;
      covariance = updated.covariance;
    }

    const latLon = unprojectFromMeters(state[0], state[1], refLat, refLon);
    writeEstimate(row, latLon, state, covariance);
    row.kalman_status = velocity ? "predicted_and_updated_with_position_velocity" : "predicted_and_updated_with_position_only";
    row.kalman_note = velocity
      ? "Kalman prediction from previous same-MMSI scene, then update with AIS position and available SOG/COG."
      : "Kalman prediction from previous same-MMSI scene, then update with AIS position only because SOG/COG was unavailable.";
    predictedAndUpdated += 1;
    if (!velocity) positionOnly += 1;
    previousTime = item.time;
  }
}

for (const row of rows) {
  if (row.kalman_status === "skipped_missing_required_position_or_time") skipped += 1;
}

writeFileSync(outputPath, stringifyCsv(outputHeaders, rows), "utf8");

const meanResidual = residuals.length ? residuals.reduce((a, b) => a + b, 0) / residuals.length : NaN;
const sortedResiduals = residuals.toSorted((a, b) => a - b);
const medianResidual = sortedResiduals.length
  ? sortedResiduals[Math.floor(sortedResiduals.length / 2)]
  : NaN;

const report = [
  "Kalman AIS/SAR report",
  "",
  `Input: ${relative(repoRoot, inputPath)}`,
  `Output: ${relative(repoRoot, outputPath)}`,
  "",
  `Rows: ${rows.length}`,
  `Rows with usable AIS position/time: ${rowsWithPosition}`,
  `Rows skipped: ${skipped}`,
  `Unique MMSI with usable rows: ${groups.size}`,
  `Rows with SOG/COG velocity measurement: ${rowsWithVelocity}`,
  `Rows without SOG/COG velocity measurement: ${rowsWithoutVelocity}`,
  `Initialized tracks: ${initialized}`,
  `Predicted and updated rows: ${predictedAndUpdated}`,
  `Position-only Kalman updates: ${positionOnly}`,
  `Mean prediction residual before update (m): ${formatNumber(meanResidual, 3)}`,
  `Median prediction residual before update (m): ${formatNumber(medianResidual, 3)}`,
  "",
  "Model:",
  "- State: [east_m, north_m, east_velocity_mps, north_velocity_mps]",
  "- Motion model: constant velocity between observations of the same MMSI",
  "- Position measurement: AIS_Latitude and AIS_Longitude",
  "- Velocity measurement: SOG/COG only when present in the input row",
  "- SOG/COG is not invented when missing; those rows are updated with position only.",
  "",
  "Parameters:",
  `- Process acceleration sigma: ${processAccelerationSigma} m/s^2`,
  `- Position measurement sigma: ${positionMeasurementSigma} m`,
  "- Velocity measurement sigma: 0.75 m/s for existing values; 1.0 m/s for stationary SOG=0; 2.5 m/s for inter-scene AIS lat/lon estimates.",
].join("\n");

writeFileSync(reportPath, report, "utf8");
console.log(report);

function velocityMeasurement(row) {
  const sog = number(row.Sog);
  const cog = number(row.Cog);
  if (!Number.isFinite(sog) || !Number.isFinite(cog) || sog < 0) return null;
  const speed = sog * 0.514444;
  const rad = toRad(((cog % 360) + 360) % 360);
  const source = velocitySource(row);
  return {
    vx: speed * Math.sin(rad),
    vy: speed * Math.cos(rad),
    sigma: velocitySigma(source, sog),
    source,
  };
}

function velocitySource(row) {
  const formulaStatus = value(row.ais_latlon_formula_status);
  if (formulaStatus === "filled_from_same_mmsi_ais_latlon_inter_scene") return "same_mmsi_ais_latlon_inter_scene_formula";
  if (formulaStatus === "filled_stationary_cog_placeholder") return "existing_Sog_0_stationary_Cog_placeholder";
  if (formulaStatus === "already_complete") return value(row.sog_cog_source) || "existing_or_enriched_Sog_Cog";
  if (value(row.sog_cog_completion_status) === "filled_from_gfw_track_observed_speed_course") return "GFW_track_observed_speed_course";
  return value(row.sog_cog_source) || value(row.sog_cog_completion_source) || "existing_or_enriched_Sog_Cog";
}

function velocitySigma(source, sog) {
  if (source === "same_mmsi_ais_latlon_inter_scene_formula") return 2.5;
  if (source === "existing_Sog_0_stationary_Cog_placeholder" || sog === 0) return 1.0;
  return 0.75;
}

function predict(state, covariance, dtSeconds) {
  const f = [
    [1, 0, dtSeconds, 0],
    [0, 1, 0, dtSeconds],
    [0, 0, 1, 0],
    [0, 0, 0, 1],
  ];
  const q = processNoise(dtSeconds, processAccelerationSigma);
  return {
    state: matVecMul(f, state),
    covariance: matAdd(matMul(matMul(f, covariance), transpose(f)), q),
  };
}

function updatePosition(state, covariance, x, y) {
  const h = [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
  ];
  const r = diag([positionMeasurementSigma ** 2, positionMeasurementSigma ** 2]);
  return kalmanUpdate(state, covariance, [x, y], h, r);
}

function updateVelocity(state, covariance, vx, vy, sigma) {
  const h = [
    [0, 0, 1, 0],
    [0, 0, 0, 1],
  ];
  const r = diag([sigma ** 2, sigma ** 2]);
  return kalmanUpdate(state, covariance, [vx, vy], h, r);
}

function kalmanUpdate(state, covariance, measurement, h, r) {
  const ht = transpose(h);
  const innovation = vecSub(measurement, matVecMul(h, state));
  const s = matAdd(matMul(matMul(h, covariance), ht), r);
  const invS = inverse2(s);
  const k = matMul(matMul(covariance, ht), invS);
  const updatedState = vecAdd(state, matVecMul(k, innovation));
  const kh = matMul(k, h);
  const iMinusKh = matSub(identity(4), kh);
  const updatedCovariance = matMul(iMinusKh, covariance);
  return { state: updatedState, covariance: symmetrize(updatedCovariance) };
}

function writeEstimate(row, latLon, state, covariance) {
  row.kalman_est_lat = formatNumber(latLon.lat, 8);
  row.kalman_est_lon = formatNumber(latLon.lon, 8);
  const speedMps = Math.hypot(state[2], state[3]);
  row.kalman_est_sog = formatNumber(speedMps / 0.514444, 6);
  row.kalman_est_cog = speedMps > 1e-9 ? formatAngle(toDeg(Math.atan2(state[2], state[3]))) : "0";
  row.kalman_est_position_sigma_m = formatNumber(Math.sqrt(Math.max(0, (covariance[0][0] + covariance[1][1]) / 2)), 3);
  row.kalman_est_velocity_sigma_mps = formatNumber(Math.sqrt(Math.max(0, (covariance[2][2] + covariance[3][3]) / 2)), 6);
  row.kalman_velocity_measurement_sigma_mps = row.kalman_velocity_measurement_used === "true"
    ? formatNumber(velocitySigma(row.kalman_velocity_measurement_source, number(row.Sog)), 6)
    : "";
}

function processNoise(dt, sigmaA) {
  const q = sigmaA ** 2;
  const dt2 = dt ** 2;
  const dt3 = dt ** 3;
  const dt4 = dt ** 4;
  return [
    [0.25 * dt4 * q, 0, 0.5 * dt3 * q, 0],
    [0, 0.25 * dt4 * q, 0, 0.5 * dt3 * q],
    [0.5 * dt3 * q, 0, dt2 * q, 0],
    [0, 0.5 * dt3 * q, 0, dt2 * q],
  ];
}

function projectToMeters(lat, lon, refLat, refLon) {
  const earthM = 6371008.8;
  return {
    x: toRad(lon - refLon) * earthM * Math.cos(toRad(refLat)),
    y: toRad(lat - refLat) * earthM,
  };
}

function unprojectFromMeters(x, y, refLat, refLon) {
  const earthM = 6371008.8;
  return {
    lat: refLat + toDeg(y / earthM),
    lon: refLon + toDeg(x / (earthM * Math.cos(toRad(refLat)))),
  };
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

function escapeCsv(input) {
  const s = String(input ?? "");
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

function sceneTimestamp(row) {
  const match = value(row.scene).match(/(\d{8}T\d{6})/);
  if (!match) return null;
  const s = match[1];
  const date = new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function finiteLatLon(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
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

function formatNumber(input, digits) {
  return Number.isFinite(input) ? input.toFixed(digits).replace(/\.?0+$/, "") : "";
}

function formatAngle(input) {
  if (!Number.isFinite(input)) return "";
  return formatNumber(((input % 360) + 360) % 360, 6);
}

function toRad(deg) {
  return deg * Math.PI / 180;
}

function toDeg(rad) {
  return rad * 180 / Math.PI;
}

function identity(n) {
  return Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
}

function diag(values) {
  return values.map((value, i) => values.map((_, j) => (i === j ? value : 0)));
}

function transpose(a) {
  return a[0].map((_, col) => a.map((row) => row[col]));
}

function matMul(a, b) {
  return a.map((row) => b[0].map((_, col) => row.reduce((sum, value, i) => sum + value * b[i][col], 0)));
}

function matVecMul(a, v) {
  return a.map((row) => row.reduce((sum, value, i) => sum + value * v[i], 0));
}

function matAdd(a, b) {
  return a.map((row, i) => row.map((value, j) => value + b[i][j]));
}

function matSub(a, b) {
  return a.map((row, i) => row.map((value, j) => value - b[i][j]));
}

function vecAdd(a, b) {
  return a.map((value, i) => value + b[i]);
}

function vecSub(a, b) {
  return a.map((value, i) => value - b[i]);
}

function inverse2(m) {
  const det = m[0][0] * m[1][1] - m[0][1] * m[1][0];
  if (Math.abs(det) < 1e-12) throw new Error("Kalman innovation matrix is singular.");
  return [
    [m[1][1] / det, -m[0][1] / det],
    [-m[1][0] / det, m[0][0] / det],
  ];
}

function symmetrize(m) {
  return m.map((row, i) => row.map((value, j) => (value + m[j][i]) / 2));
}
