import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const args = parseArgs(process.argv.slice(2));

const inputDir = resolve(args["input-dir"] ?? join(repoRoot, "Dataset_Test_Enriched"));
const outputDir = resolve(args["output-dir"] ?? join(inputDir, "trajectory_outputs"));
const samplePerLabel = positiveInteger(args["sample-per-label"], 0);
const maxGapHours = positiveNumber(args["max-gap-hours"], 24);
const processAccelerationSigma = positiveNumber(args["process-acceleration-sigma"], 0.03);
const positionMeasurementSigma = positiveNumber(args["position-measurement-sigma"], 50);
const velocityMeasurementSigma = positiveNumber(args["velocity-measurement-sigma"], 0.75);
const useVelocityMeasurements = args["position-only"] !== true;
const bestPerLabel = positiveInteger(args["best-per-label"], 3);
const sequenceScope = value(args["sequence-scope"] ?? "segment").toLowerCase();
const sequenceSelectionStrategy = value(
  args["sequence-selection"] ?? (sequenceScope === "mmsi" ? "distance-spread" : "residual-window"),
).toLowerCase();
const sequenceLimitPerTrack = positiveInteger(
  args["sequence-limit-per-track"] ?? args["sequence-limit-per-vessel"] ?? args["sequence-per-vessel"],
  0,
);

if (!existsSync(inputDir)) throw new Error(`Input directory does not exist: ${inputDir}`);
if (!["segment", "mmsi"].includes(sequenceScope)) {
  throw new Error("--sequence-scope must be either 'segment' or 'mmsi'.");
}
if (!["distance-spread", "even-index", "residual-window"].includes(sequenceSelectionStrategy)) {
  throw new Error("--sequence-selection must be distance-spread, even-index, or residual-window.");
}
if (existsSync(outputDir)) {
  throw new Error(
    `Output directory already exists: ${outputDir}\n` +
    "Rename or back up the existing directory, then run again with a new output path.",
  );
}

const inputFiles = readdirSync(inputDir)
  .filter((name) => name.toLowerCase().endsWith(".csv"))
  .sort()
  .map((name) => join(inputDir, name));

if (!inputFiles.length) throw new Error(`No CSV files found in ${inputDir}`);

const requiredColumns = [
  "mmsi",
  "timestamp",
  "lat",
  "lon",
  "speed",
  "course",
  "is_fishing",
  "seg_id",
  "vessel_name",
  "gear_label",
];

const sourceHeaders = [];
const sourceRows = [];
for (const inputPath of inputFiles) {
  const { headers, rows } = parseCsv(readFileSync(inputPath, "utf8"));
  const missing = requiredColumns.filter((column) => !headers.includes(column));
  if (missing.length) {
    throw new Error(`${basename(inputPath)} is missing required columns: ${missing.join(", ")}`);
  }
  for (const header of headers) {
    if (!sourceHeaders.includes(header)) sourceHeaders.push(header);
  }
  for (const row of rows) {
    sourceRows.push({
      ...row,
      input_file: basename(inputPath),
      _sourceIndex: sourceRows.length,
    });
  }
}

const validItems = sourceRows
  .map((row) => ({
    row,
    time: parseDate(row.timestamp),
    lat: number(row.lat),
    lon: number(row.lon),
  }))
  .filter((item) => value(item.row.mmsi) && value(item.row.seg_id) && item.time && finiteLatLon(item.lat, item.lon));

const invalidRows = sourceRows.length - validItems.length;
const segmentGroups = groupBy(validItems, (item) => value(item.row.seg_id));
for (const group of segmentGroups.values()) {
  group.sort((a, b) => a.time - b.time || a.row._sourceIndex - b.row._sourceIndex);
}

let selectedGroups;
let selectedItems;
const trackParts = [];

if (sequenceScope === "mmsi") {
  selectedItems = validItems;
  selectedGroups = groupBy(selectedItems, (item) => value(item.row.mmsi));
  for (const [mmsi, group] of selectedGroups) {
    group.sort((a, b) => a.time - b.time || a.row._sourceIndex - b.row._sourceIndex);
    trackParts.push(makeMmsiTrackPart(mmsi, group));
  }
} else {
  let selectedSegmentIds = new Set(segmentGroups.keys());
  if (samplePerLabel > 0) {
    selectedSegmentIds = new Set();
    const candidatesByLabel = new Map();
    for (const [segmentId, group] of segmentGroups) {
      const label = value(group[0].row.gear_label) || "unknown";
      if (!candidatesByLabel.has(label)) candidatesByLabel.set(label, []);
      candidatesByLabel.get(label).push({ segmentId, pointCount: group.length });
    }
    for (const candidates of candidatesByLabel.values()) {
      candidates
        .sort((a, b) => b.pointCount - a.pointCount || a.segmentId.localeCompare(b.segmentId))
        .slice(0, samplePerLabel)
        .forEach((candidate) => selectedSegmentIds.add(candidate.segmentId));
    }
  }

  selectedItems = validItems.filter((item) => selectedSegmentIds.has(value(item.row.seg_id)));
  selectedGroups = groupBy(selectedItems, (item) => value(item.row.seg_id));

  for (const [segmentId, group] of selectedGroups) {
    group.sort((a, b) => a.time - b.time || a.row._sourceIndex - b.row._sourceIndex);
    let current = [];
    let partIndex = 1;
    for (const item of group) {
      const previous = current.at(-1);
      const gapHours = previous ? (item.time - previous.time) / 3_600_000 : 0;
      const crossesDateline = previous ? Math.abs(item.lon - previous.lon) > 180 : false;
      if (previous && (gapHours > maxGapHours || gapHours < 0 || crossesDateline)) {
        trackParts.push(makeTrackPart(segmentId, partIndex, current));
        current = [];
        partIndex += 1;
      }
      current.push(item);
    }
    if (current.length) trackParts.push(makeTrackPart(segmentId, partIndex, current));
  }
}

for (const track of trackParts) runKalman(track);

const outputTrackParts = sequenceLimitPerTrack > 0
  ? trackParts.map((track) => limitTrackForSequenceExport(track, sequenceLimitPerTrack))
  : trackParts;

mkdirSync(outputDir, { recursive: false });
const svgAllDir = join(outputDir, "svg_all");
const bestDir = join(outputDir, "svg_best_examples");
mkdirSync(svgAllDir, { recursive: true });
mkdirSync(bestDir, { recursive: true });

const pointRows = [];
const summaries = [];
const rawFeatures = [];
const kalmanFeatures = [];

for (const track of outputTrackParts) {
  const sourcePointCount = track.sourcePointCount ?? track.items.length;
  const selectionStart = track.selectionStartSourceSequence ?? 1;
  const selectionEnd = track.selectionEndSourceSequence ?? track.items.length;
  const stats = trajectoryStats(track.items);
  const gearDir = join(svgAllDir, safeFileName(track.gearLabel));
  mkdirSync(gearDir, { recursive: true });
  const svgName = trajectoryFileName(track);
  const svgPath = join(gearDir, svgName);
  let svgRelative = "";
  let status = "single_point";
  let note = "Only one valid AIS point is available in this track part; no line was created.";

  if (track.items.length < 2) {
    status = "single_point";
    note = "Only one valid AIS point is available in this track part; no line was created.";
  } else if (stats.uniqueCoordinateCount < 2) {
    status = "overlap_only";
    note = "Multiple timestamps exist, but all valid AIS coordinates overlap; no meaningful trajectory line was created.";
  } else {
    writeFileSync(svgPath, renderSvgConcept(track, stats), "utf8");
    svgRelative = normalizePath(relative(outputDir, svgPath));
    status = "trajectory_ready";
    note = sequenceLimitPerTrack > 0
      ? (
        sourcePointCount > track.items.length
          ? `Kalman is calculated on all ${sourcePointCount} ordered observations in this continuous track part. The SVG overview uses the full track, while the detail and CSV export use ${track.items.length} contiguous real observations from source sequence ${selectionStart}-${selectionEnd}, selected with ${sequenceSelectionStrategy}. No interpolation or synthetic points were added.`
          : `AIS input and Kalman use all ${track.items.length} available real sequence points because this track has no more than the ${sequenceLimitPerTrack}-sequence limit. No interpolation or synthetic points were added.`
      )
      : `AIS input and Kalman use and display all ${track.items.length} timestamped points. The SVG magnifies only the visual AIS-to-Kalman residual and labels its factor; CSV/GeoJSON coordinates remain original. No interpolation, point limiting, or synthetic points were added.`;

    rawFeatures.push(lineFeature(track, stats, "ais_input", track.items.map((item) => [item.lon, item.lat])));
    kalmanFeatures.push(
      lineFeature(
        track,
        stats,
        "kalman_estimate",
        track.items.map((item) => [item.kalmanLon, item.kalmanLat]),
      ),
    );
  }

  summaries.push({
    gear_label: track.gearLabel,
    mmsi: track.mmsi,
    vessel_name: track.vesselName,
    seg_id: track.segmentId,
    track_id: track.trackId,
    track_part_index: track.partIndex,
    point_count: track.items.length,
    source_point_count: sourcePointCount,
    sequence_window_start_source_index: selectionStart,
    sequence_window_end_source_index: selectionEnd,
    sequence_limit_per_track: sequenceLimitPerTrack || "",
    sequence_selection_strategy: sequenceSelectionStrategy,
    sequence_scope: sequenceScope,
    unique_coordinate_count: stats.uniqueCoordinateCount,
    start_time: track.items[0].time.toISOString(),
    end_time: track.items.at(-1).time.toISOString(),
    time_span_hours: formatNumber(stats.timeSpanHours, 6),
    total_distance_m: formatNumber(stats.totalDistanceM, 3),
    displacement_m: formatNumber(stats.displacementM, 3),
    spatial_span_m: formatNumber(stats.spatialSpanM, 3),
    max_gap_hours: formatNumber(stats.maxGapHours, 6),
    fishing_point_count: stats.fishingPointCount,
    non_fishing_point_count: stats.nonFishingPointCount,
    svg_path: svgRelative,
    status,
    catatan: note,
  });

  for (let i = 0; i < track.items.length; i += 1) {
    const item = track.items[i];
    pointRows.push({
      ...Object.fromEntries(sourceHeaders.map((header) => [header, item.row[header] ?? ""])),
      input_file: item.row.input_file,
      track_id: track.trackId,
      track_part_index: track.partIndex,
      sequence_index: i + 1,
      source_sequence_index: item.sourceSequenceIndex ?? i + 1,
      source_track_point_count: sourcePointCount,
      track_point_count: track.items.length,
      sequence_scope: sequenceScope,
      kalman_status: item.kalmanStatus,
      kalman_dt_seconds: formatNumber(item.kalmanDtSeconds, 3),
      kalman_pred_lat: formatNumber(item.kalmanPredLat, 8),
      kalman_pred_lon: formatNumber(item.kalmanPredLon, 8),
      kalman_est_lat: formatNumber(item.kalmanLat, 8),
      kalman_est_lon: formatNumber(item.kalmanLon, 8),
      kalman_est_speed_knots: formatNumber(item.kalmanSpeedKnots, 6),
      kalman_est_course_deg: formatNumber(item.kalmanCourseDeg, 6),
      kalman_prediction_residual_m: formatNumber(item.kalmanResidualM, 3),
      kalman_position_sigma_m: formatNumber(item.kalmanPositionSigmaM, 3),
      kalman_velocity_sigma_mps: formatNumber(item.kalmanVelocitySigmaMps, 6),
      kalman_model: "constant_velocity_xy",
      kalman_process_acceleration_sigma_mps2: formatNumber(processAccelerationSigma, 6),
      kalman_position_measurement_sigma_m: formatNumber(positionMeasurementSigma, 3),
      kalman_velocity_measurement_sigma_mps: formatNumber(velocityMeasurementSigma, 3),
    });
  }
}

summaries.sort(
  (a, b) =>
    a.gear_label.localeCompare(b.gear_label) ||
    Number(b.source_point_count) - Number(a.source_point_count) ||
    b.point_count - a.point_count ||
    a.track_id.localeCompare(b.track_id),
);

const bestSummaries = [];
const summariesByLabel = groupBy(summaries.filter((row) => row.status === "trajectory_ready"), (row) => row.gear_label);
for (const group of summariesByLabel.values()) {
  const ranked = group.toSorted(
    (a, b) =>
      Number(b.source_point_count) - Number(a.source_point_count) ||
      b.point_count - a.point_count ||
      b.unique_coordinate_count - a.unique_coordinate_count ||
      Number(b.spatial_span_m) - Number(a.spatial_span_m) ||
      Number(b.total_distance_m) - Number(a.total_distance_m),
  );
  const selectedMmsi = new Set();
  for (const summary of ranked) {
    if (selectedMmsi.has(summary.mmsi)) continue;
    selectedMmsi.add(summary.mmsi);
    const source = join(outputDir, summary.svg_path);
    const destinationName = `${safeFileName(summary.gear_label)}_${basename(source)}`;
    const destination = join(bestDir, destinationName);
    copyFileSync(source, destination);
    bestSummaries.push({
      ...summary,
      best_svg_path: normalizePath(relative(outputDir, destination)),
    });
    if (selectedMmsi.size >= bestPerLabel) break;
  }
}

const pointHeaders = [
  ...sourceHeaders,
  "input_file",
  "track_id",
  "track_part_index",
  "sequence_index",
  "source_sequence_index",
  "source_track_point_count",
  "track_point_count",
  "sequence_scope",
  "kalman_status",
  "kalman_dt_seconds",
  "kalman_pred_lat",
  "kalman_pred_lon",
  "kalman_est_lat",
  "kalman_est_lon",
  "kalman_est_speed_knots",
  "kalman_est_course_deg",
  "kalman_prediction_residual_m",
  "kalman_position_sigma_m",
  "kalman_velocity_sigma_mps",
  "kalman_model",
  "kalman_process_acceleration_sigma_mps2",
  "kalman_position_measurement_sigma_m",
  "kalman_velocity_measurement_sigma_mps",
];

const summaryHeaders = [
  "gear_label",
  "mmsi",
  "vessel_name",
  "seg_id",
  "track_id",
  "track_part_index",
  "point_count",
  "source_point_count",
  "sequence_window_start_source_index",
  "sequence_window_end_source_index",
  "sequence_limit_per_track",
  "sequence_selection_strategy",
  "sequence_scope",
  "unique_coordinate_count",
  "start_time",
  "end_time",
  "time_span_hours",
  "total_distance_m",
  "displacement_m",
  "spatial_span_m",
  "max_gap_hours",
  "fishing_point_count",
  "non_fishing_point_count",
  "svg_path",
  "status",
  "catatan",
];

writeFileSync(join(outputDir, "trajectory_points_raw_vs_kalman.csv"), stringifyCsv(pointHeaders, pointRows), "utf8");
writeFileSync(join(outputDir, "trajectory_segments_summary.csv"), stringifyCsv(summaryHeaders, summaries), "utf8");
writeFileSync(
  join(outputDir, "trajectory_best_examples_summary.csv"),
  stringifyCsv([...summaryHeaders, "best_svg_path"], bestSummaries),
  "utf8",
);
writeFileSync(
  join(outputDir, "trajectories_ais_input.geojson"),
  JSON.stringify({ type: "FeatureCollection", features: rawFeatures }, null, 2),
  "utf8",
);
writeFileSync(
  join(outputDir, "trajectories_kalman.geojson"),
  JSON.stringify({ type: "FeatureCollection", features: kalmanFeatures }, null, 2),
  "utf8",
);
writeFileSync(
  join(outputDir, "trajectories_ais_input_vs_kalman.geojson"),
  JSON.stringify({ type: "FeatureCollection", features: [...rawFeatures, ...kalmanFeatures] }, null, 2),
  "utf8",
);
writeFileSync(join(outputDir, "trajectory_gallery.html"), renderGallery(bestSummaries), "utf8");

const labels = [...new Set(summaries.map((row) => row.gear_label))].sort();
const readyCount = summaries.filter((row) => row.status === "trajectory_ready").length;
const resetParts = sequenceScope === "segment" ? trackParts.length - selectedGroups.size : 0;
const sequenceUnitLabel = sequenceScope === "mmsi" ? "MMSI/vessel" : "output trajectory";
const groupCountLabel = sequenceScope === "mmsi" ? "Selected MMSI groups" : "Selected original seg_id groups";
const outputCountLabel = sequenceScope === "mmsi" ? "Output MMSI trajectories" : "Output track parts";
const selectionNote = sequenceSelectionStrategy === "distance-spread"
  ? `- Longer ${sequenceUnitLabel} groups are sampled by cumulative trajectory distance, so the selected points are spread across the route.`
  : sequenceSelectionStrategy === "even-index"
    ? `- Longer ${sequenceUnitLabel} groups are sampled by evenly spaced source indexes.`
    : `- Longer ${sequenceUnitLabel} groups use the most informative contiguous real-observation window around a strong AIS-to-Kalman correction, while penalizing nearly stationary/duplicate-coordinate windows.`;
const sequencePolicyNotes = sequenceLimitPerTrack > 0
  ? [
    `- Each output ${sequenceUnitLabel} uses at most ${sequenceLimitPerTrack} real AIS sequence points.`,
    selectionNote,
    "- Kalman is calculated once on the complete continuous track part before the detail window is selected.",
    "- Each SVG contains a full-track overview, a true-coordinate detail window, and an AIS-to-Kalman residual chart.",
    "- Only selected anchor points are labeled; labels use collision avoidance and leader lines.",
  ]
  : [
    "- Every valid point in each track part is included in both SVG paths; points are not limited to a fixed count.",
  ];
const report = [
  "Labeled AIS trajectory export report",
  "",
  `Input directory: ${normalizePath(relative(repoRoot, inputDir))}`,
  `Output directory: ${normalizePath(relative(repoRoot, outputDir))}`,
  `Mode: ${samplePerLabel > 0 ? `sample (${samplePerLabel} source segment per label)` : "full dataset"}`,
  `Sequence grouping scope: ${sequenceScope}`,
  `Sequence selection strategy: ${sequenceSelectionStrategy}`,
  "",
  `Input CSV files: ${inputFiles.length}`,
  `Input rows: ${sourceRows.length}`,
  `Usable AIS rows in this run: ${selectedItems.length}`,
  `Exported trajectory point rows: ${pointRows.length}`,
  `Invalid/skipped input rows in all source files: ${invalidRows}`,
  `${groupCountLabel}: ${selectedGroups.size}`,
  `${outputCountLabel}: ${trackParts.length}`,
  `Sequence limit per ${sequenceUnitLabel}: ${sequenceLimitPerTrack > 0 ? sequenceLimitPerTrack : "none"}`,
  `Additional parts caused by gaps > ${maxGapHours} hours or dateline crossing: ${resetParts}`,
  `Trajectory-ready SVG files: ${readyCount}`,
  `Best-example SVG files: ${bestSummaries.length}`,
  `Gear labels: ${labels.join(", ")}`,
  "",
  "Color convention:",
  "- RED dashed line: original AIS input from timestamp/lat/lon.",
  "- BLUE line: Kalman estimate calculated from the same ordered AIS observations.",
  `- RED markers: AIS observations in the detail panel; BLUE markers: matching Kalman estimates.`,
  "- GRAY dashed lines: AIS-to-Kalman correction / adjustment at each sequence point.",
  ...sequencePolicyNotes,
  "- Coordinates are not magnified or shifted in the new three-panel SVG. The residual chart reports the difference directly in meters.",
  "",
  "Segmentation and integrity:",
  sequenceScope === "mmsi"
    ? "- Trajectories are grouped by MMSI, so each vessel has one output trajectory."
    : "- Tracks are grouped by the existing seg_id field.",
  sequenceScope === "mmsi"
    ? "- No seg_id splitting is applied in MMSI mode."
    : `- A new visual/model track part is started when the internal time gap exceeds ${maxGapHours} hours.`,
  "- No interpolation, resampling, or synthetic AIS points are created.",
  "- Source CSV files are read-only and are not modified.",
  "",
  "Kalman model:",
  "- State: [east_m, north_m, east_velocity_mps, north_velocity_mps].",
  sequenceScope === "mmsi"
    ? "- Motion model: constant velocity between consecutive observations in one MMSI sequence."
    : "- Motion model: constant velocity between consecutive observations in one track part.",
  "- Position measurements: original AIS lat/lon.",
  `- Velocity measurements: ${useVelocityMeasurements ? "original speed/course when both values are valid" : "disabled; velocity is estimated from the ordered position updates"}.`,
  `- Process acceleration sigma: ${processAccelerationSigma} m/s^2.`,
  `- Position measurement sigma: ${positionMeasurementSigma} m.`,
  `- Velocity measurement sigma: ${velocityMeasurementSigma} m/s.`,
].join("\n");

writeFileSync(join(outputDir, "README.txt"), report, "utf8");
console.log(report);

function makeTrackPart(segmentId, partIndex, items) {
  const first = items[0].row;
  return {
    segmentId,
    partIndex,
    trackId: `${segmentId}-part${String(partIndex).padStart(2, "0")}`,
    mmsi: value(first.mmsi),
    vesselName: value(first.vessel_name) || "Unnamed",
    gearLabel: value(first.gear_label) || "unknown",
    items,
  };
}

function makeMmsiTrackPart(mmsi, items) {
  const first = items[0].row;
  return {
    segmentId: `${mmsi}-mmsi`,
    partIndex: 1,
    trackId: `${mmsi}-mmsi`,
    mmsi,
    vesselName: firstNonBlank(items.map((item) => item.row.vessel_name)) || "Unnamed",
    gearLabel: firstNonBlank(items.map((item) => item.row.gear_label)) || value(first.gear_label) || "unknown",
    items,
  };
}

function limitTrackForSequenceExport(track, maximumPoints) {
  const selected = selectSequenceItems(track.items, maximumPoints, sequenceSelectionStrategy);
  const selectedSourceIndexes = selected.map((item) => track.items.indexOf(item) + 1);
  const startIndex = Math.min(...selectedSourceIndexes) - 1;
  const endIndex = Math.max(...selectedSourceIndexes) - 1;
  const clonedItems = selected.map((item, index) => ({
    ...item,
    sourceSequenceIndex: selectedSourceIndexes[index],
  }));
  return {
    ...track,
    items: clonedItems,
    sourceItems: track.items,
    sourcePointCount: track.items.length,
    selectionStartSourceSequence: startIndex + 1,
    selectionEndSourceSequence: endIndex + 1,
  };
}

function runKalman(track) {
  const refLat = track.items[0].lat;
  const refLon = track.items[0].lon;
  let state = null;
  let covariance = null;
  let previousTime = null;

  for (const item of track.items) {
    const position = projectToMeters(item.lat, item.lon, refLat, refLon);
    const velocity = useVelocityMeasurements ? velocityMeasurement(item.row) : null;
    item.kalmanDtSeconds = previousTime ? Math.max(0, (item.time - previousTime) / 1000) : 0;
    item.kalmanPredLat = NaN;
    item.kalmanPredLon = NaN;
    item.kalmanResidualM = NaN;

    if (!state) {
      state = [position.x, position.y, velocity?.vx ?? 0, velocity?.vy ?? 0];
      covariance = diag([
        positionMeasurementSigma ** 2,
        positionMeasurementSigma ** 2,
        velocity ? velocityMeasurementSigma ** 2 : 25 ** 2,
        velocity ? velocityMeasurementSigma ** 2 : 25 ** 2,
      ]);
      let updated = updatePosition(state, covariance, position.x, position.y);
      state = updated.state;
      covariance = updated.covariance;
      if (velocity) {
        updated = updateVelocity(state, covariance, velocity.vx, velocity.vy);
        state = updated.state;
        covariance = updated.covariance;
      }
      item.kalmanStatus = velocity ? "initialized_position_velocity" : "initialized_position_only";
    } else {
      const predicted = predict(state, covariance, item.kalmanDtSeconds);
      const predLatLon = unprojectFromMeters(predicted.state[0], predicted.state[1], refLat, refLon);
      item.kalmanPredLat = predLatLon.lat;
      item.kalmanPredLon = predLatLon.lon;
      item.kalmanResidualM = Math.hypot(position.x - predicted.state[0], position.y - predicted.state[1]);

      let updated = updatePosition(predicted.state, predicted.covariance, position.x, position.y);
      state = updated.state;
      covariance = updated.covariance;
      if (velocity) {
        updated = updateVelocity(state, covariance, velocity.vx, velocity.vy);
        state = updated.state;
        covariance = updated.covariance;
      }
      item.kalmanStatus = velocity ? "updated_position_velocity" : "updated_position_only";
    }

    const estimate = unprojectFromMeters(state[0], state[1], refLat, refLon);
    const speedMps = Math.hypot(state[2], state[3]);
    item.kalmanLat = estimate.lat;
    item.kalmanLon = estimate.lon;
    item.kalmanSpeedKnots = speedMps / 0.514444;
    item.kalmanCourseDeg = speedMps > 1e-9 ? normalizeAngle(toDeg(Math.atan2(state[2], state[3]))) : 0;
    item.kalmanPositionSigmaM = Math.sqrt(Math.max(0, (covariance[0][0] + covariance[1][1]) / 2));
    item.kalmanVelocitySigmaMps = Math.sqrt(Math.max(0, (covariance[2][2] + covariance[3][3]) / 2));
    previousTime = item.time;
  }
}

function trajectoryStats(items) {
  let totalDistanceM = 0;
  let maxGapHours = 0;
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  let fishingPointCount = 0;
  let nonFishingPointCount = 0;
  const uniqueCoordinates = new Set();

  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    minLat = Math.min(minLat, item.lat);
    maxLat = Math.max(maxLat, item.lat);
    minLon = Math.min(minLon, item.lon);
    maxLon = Math.max(maxLon, item.lon);
    uniqueCoordinates.add(`${item.lat.toFixed(7)}|${item.lon.toFixed(7)}`);
    if (value(item.row.is_fishing) === "1") fishingPointCount += 1;
    if (value(item.row.is_fishing) === "0") nonFishingPointCount += 1;
    if (i > 0) {
      totalDistanceM += haversineM(items[i - 1].lat, items[i - 1].lon, item.lat, item.lon);
      maxGapHours = Math.max(maxGapHours, (item.time - items[i - 1].time) / 3_600_000);
    }
  }

  return {
    uniqueCoordinateCount: uniqueCoordinates.size,
    timeSpanHours: items.length > 1 ? (items.at(-1).time - items[0].time) / 3_600_000 : 0,
    totalDistanceM,
    displacementM: items.length > 1
      ? haversineM(items[0].lat, items[0].lon, items.at(-1).lat, items.at(-1).lon)
      : 0,
    spatialSpanM: finiteLatLon(minLat, minLon) && finiteLatLon(maxLat, maxLon)
      ? haversineM(minLat, minLon, maxLat, maxLon)
      : 0,
    maxGapHours,
    fishingPointCount,
    nonFishingPointCount,
  };
}

function renderSvgConcept(track, stats) {
  const width = 1800;
  const height = 1180;
  const overviewFrame = { x: 55, y: 170, width: 650, height: 510 };
  const detailFrame = { x: 750, y: 170, width: 995, height: 510 };
  const residualFrame = { x: 55, y: 760, width: 1690, height: 270 };
  const fullItems = track.sourceItems ?? track.items;
  const detailItems = track.items;

  const fullRefLat = fullItems[0].lat;
  const fullRefLon = fullItems[0].lon;
  const fullRawProjected = fullItems.map((item) => projectToMeters(item.lat, item.lon, fullRefLat, fullRefLon));
  const fullKalmanProjected = fullItems.map((item) =>
    projectToMeters(item.kalmanLat, item.kalmanLon, fullRefLat, fullRefLon));
  const overviewViewport = fitViewport(
    [...fullRawProjected, ...fullKalmanProjected],
    insetFrame(overviewFrame, 30, 28),
    0.05,
    100,
  );
  const fullRawScreen = fullRawProjected.map((point) => overviewViewport.map(point));
  const fullKalmanScreen = fullKalmanProjected.map((point) => overviewViewport.map(point));
  const detailOverviewScreen = detailItems.map((item) =>
    overviewViewport.map(projectToMeters(item.lat, item.lon, fullRefLat, fullRefLon)));
  const overviewMarkerStep = Math.max(1, Math.ceil(fullItems.length / 100));
  const overviewMarkers = fullRawScreen
    .filter((_, index) => index === 0 || index === fullRawScreen.length - 1 || index % overviewMarkerStep === 0)
    .map(([x, y]) => `<circle cx="${formatNumber(x, 2)}" cy="${formatNumber(y, 2)}" r="2.6" class="overview-point"/>`)
    .join("\n");

  const detailRefLat = detailItems[0].lat;
  const detailRefLon = detailItems[0].lon;
  const detailRawProjected = detailItems.map((item) =>
    projectToMeters(item.lat, item.lon, detailRefLat, detailRefLon));
  const detailKalmanProjected = detailItems.map((item) =>
    projectToMeters(item.kalmanLat, item.kalmanLon, detailRefLat, detailRefLon));
  const detailRotation = routeRotation(detailRawProjected);
  const detailRawRotated = detailRawProjected.map((point) => rotatePoint(point, detailRotation));
  const detailKalmanRotated = detailKalmanProjected.map((point) => rotatePoint(point, detailRotation));
  const detailViewport = fitViewport(
    [...detailRawRotated, ...detailKalmanRotated],
    insetFrame(detailFrame, 55, 46),
    0.06,
    60,
  );
  const detailRawScreen = detailRawRotated.map((point) => detailViewport.map(point));
  const detailKalmanScreen = detailKalmanRotated.map((point) => detailViewport.map(point));
  const residuals = detailItems.map((item) =>
    haversineM(item.lat, item.lon, item.kalmanLat, item.kalmanLon));
  const finiteResiduals = residuals.filter(Number.isFinite);
  const maxResidualM = finiteResiduals.length ? Math.max(...finiteResiduals) : 0;
  const maxResidualIndex = residuals.indexOf(maxResidualM);
  const sortedResiduals = finiteResiduals.toSorted((a, b) => a - b);
  const medianResidualM = sortedResiduals[Math.floor((sortedResiduals.length - 1) / 2)] ?? 0;

  const detailCorrections = detailRawScreen
    .map(([x1, y1], index) => {
      const [x2, y2] = detailKalmanScreen[index];
      return `<line x1="${formatNumber(x1, 2)}" y1="${formatNumber(y1, 2)}" x2="${formatNumber(x2, 2)}" y2="${formatNumber(y2, 2)}" class="${index === maxResidualIndex ? "max-correction" : "correction"}"/>`;
    })
    .join("\n");
  const detailRawMarkers = detailRawScreen
    .map(([x, y], index) =>
      `<circle cx="${formatNumber(x, 2)}" cy="${formatNumber(y, 2)}" r="${index === maxResidualIndex ? 7.2 : 5.2}" class="raw-point"/>`)
    .join("\n");
  const detailKalmanMarkers = detailKalmanScreen
    .map(([x, y], index) =>
      `<circle cx="${formatNumber(x, 2)}" cy="${formatNumber(y, 2)}" r="${index === maxResidualIndex ? 6.4 : 4.5}" class="kalman-point"/>`)
    .join("\n");
  const labelIndexes = new Set([0, detailItems.length - 1, maxResidualIndex]);
  for (let index = 4; index < detailItems.length; index += 5) labelIndexes.add(index);
  const labels = renderCollisionAvoidingLabels(
    detailRawScreen,
    detailKalmanScreen,
    [...labelIndexes].filter((index) => index >= 0).sort((a, b) => a - b),
    insetFrame(detailFrame, 10, 10),
  );

  const residualPlot = insetFrame(residualFrame, 78, 42);
  residualPlot.height -= 24;
  const residualMaxY = Math.max(1, maxResidualM * 1.15);
  const residualScreen = residuals.map((residual, index) => [
    residualPlot.x + (detailItems.length === 1 ? residualPlot.width / 2 : (residualPlot.width * index) / (detailItems.length - 1)),
    residualPlot.y + residualPlot.height - (Math.max(0, residual) / residualMaxY) * residualPlot.height,
  ]);
  const residualGrid = [];
  for (let i = 0; i <= 4; i += 1) {
    const y = residualPlot.y + (residualPlot.height * i) / 4;
    const valueM = residualMaxY * (1 - i / 4);
    residualGrid.push(`<line x1="${residualPlot.x}" y1="${formatNumber(y, 2)}" x2="${residualPlot.x + residualPlot.width}" y2="${formatNumber(y, 2)}" class="residual-grid"/>`);
    residualGrid.push(`<text x="${residualPlot.x - 12}" y="${formatNumber(y + 5, 2)}" text-anchor="end" class="axis-text">${escapeXml(formatDistance(valueM))}</text>`);
  }
  const residualTicks = [...labelIndexes]
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)
    .map((index) => {
      const [x] = residualScreen[index];
      return `<line x1="${formatNumber(x, 2)}" y1="${residualPlot.y + residualPlot.height}" x2="${formatNumber(x, 2)}" y2="${residualPlot.y + residualPlot.height + 7}" class="axis-tick"/>
      <text x="${formatNumber(x, 2)}" y="${residualPlot.y + residualPlot.height + 24}" text-anchor="middle" class="axis-text">T${index + 1}</text>`;
    })
    .join("\n");
  const residualDots = residualScreen
    .map(([x, y], index) =>
      `<circle cx="${formatNumber(x, 2)}" cy="${formatNumber(y, 2)}" r="${index === maxResidualIndex ? 6 : 3.2}" class="${index === maxResidualIndex ? "residual-max-point" : "residual-point"}"/>`)
    .join("\n");

  const overviewStart = fullRawScreen[0];
  const overviewEnd = fullRawScreen.at(-1);
  const detailStartSource = track.selectionStartSourceSequence ?? 1;
  const detailEndSource = track.selectionEndSourceSequence ?? detailItems.length;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <clipPath id="overview-clip"><rect x="${overviewFrame.x}" y="${overviewFrame.y}" width="${overviewFrame.width}" height="${overviewFrame.height}" rx="12"/></clipPath>
    <clipPath id="detail-clip"><rect x="${detailFrame.x}" y="${detailFrame.y}" width="${detailFrame.width}" height="${detailFrame.height}" rx="12"/></clipPath>
    <clipPath id="residual-clip"><rect x="${residualPlot.x}" y="${residualPlot.y}" width="${residualPlot.width}" height="${residualPlot.height}"/></clipPath>
  </defs>
  <style>
    .bg { fill: #eef6ff; }
    .panel { fill: #ffffff; stroke: #7da6ca; stroke-width: 2; }
    .title { fill: #082f5b; font: bold 24px Arial, sans-serif; }
    .subtitle { fill: #365b78; font: 16px Arial, sans-serif; }
    .panel-title { fill: #082f5b; font: bold 18px Arial, sans-serif; }
    .panel-note { fill: #486781; font: 14px Arial, sans-serif; }
    .grid { stroke: #d7e7f5; stroke-width: 1.2; stroke-dasharray: 6 7; }
    .overview-raw { fill: none; stroke: #e53b3b; stroke-width: 2.5; stroke-dasharray: 7 6; opacity: 0.82; }
    .overview-kalman { fill: none; stroke: #1473d2; stroke-width: 3; opacity: 0.84; }
    .overview-point { fill: #ffffff; stroke: #b52222; stroke-width: 1; }
    .detail-highlight { fill: none; stroke: #ffb000; stroke-width: 8; stroke-linecap: round; stroke-linejoin: round; opacity: 0.78; }
    .raw-line { fill: none; stroke: #e31a1c; stroke-width: 4.4; stroke-dasharray: 9 7; stroke-linecap: round; stroke-linejoin: round; }
    .kalman-line { fill: none; stroke: #0066e8; stroke-width: 4.4; stroke-linecap: round; stroke-linejoin: round; }
    .correction { stroke: #64748b; stroke-width: 1.5; stroke-dasharray: 4 4; opacity: 0.75; }
    .max-correction { stroke: #111827; stroke-width: 3.3; stroke-dasharray: 7 5; }
    .raw-point { fill: #ffffff; stroke: #d7191c; stroke-width: 2; }
    .kalman-point { fill: #1688ff; stroke: #003d8f; stroke-width: 1.5; }
    .endpoint { stroke: #102a43; stroke-width: 2; }
    .start { fill: #23a55a; }
    .end { fill: #ffb000; }
    .label-leader { stroke: #334155; stroke-width: 1.2; opacity: 0.8; }
    .label-box { fill: #ffffff; stroke: #6f8fac; stroke-width: 1; opacity: 0.95; }
    .point-label { fill: #082f5b; font: bold 13px Arial, sans-serif; }
    .residual-grid { stroke: #d7e7f5; stroke-width: 1; }
    .residual-line { fill: none; stroke: #7c3aed; stroke-width: 3; stroke-linejoin: round; stroke-linecap: round; }
    .residual-area { fill: #bca7f5; opacity: 0.25; }
    .residual-point { fill: #7c3aed; stroke: #ffffff; stroke-width: 1; }
    .residual-max-point { fill: #ff8a00; stroke: #7c2d12; stroke-width: 1.5; }
    .axis-text { fill: #526b80; font: 12px Arial, sans-serif; }
    .axis-tick { stroke: #526b80; stroke-width: 1; }
    .legend-text { fill: #243b53; font: 15px Arial, sans-serif; }
    .badge { fill: #fff7df; stroke: #e7a600; stroke-width: 1.4; }
    .badge-text { fill: #7a4b00; font: bold 14px Arial, sans-serif; }
  </style>
  <rect class="bg" width="${width}" height="${height}"/>
  <text class="title" x="55" y="42">${escapeXml(track.vesselName)} | MMSI ${escapeXml(track.mmsi)} | ${escapeXml(track.gearLabel)}</text>
  <text class="subtitle" x="55" y="72">Kalman dihitung pada ${fullItems.length} observasi berurutan; detail menampilkan T1-T${detailItems.length} dari source index ${detailStartSource}-${detailEndSource}.</text>
  <text class="subtitle" x="55" y="98">KOORDINAT ASLI - TANPA MAGNIFIKASI | ${detailItems[0].time.toISOString()} sampai ${detailItems.at(-1).time.toISOString()}</text>

  <text class="panel-title" x="${overviewFrame.x}" y="${overviewFrame.y - 34}">1. OVERVIEW LINTASAN KONTINU</text>
  <text class="panel-note" x="${overviewFrame.x}" y="${overviewFrame.y - 12}">Oranye = lokasi window detail pada lintasan penuh.</text>
  <rect class="panel" x="${overviewFrame.x}" y="${overviewFrame.y}" width="${overviewFrame.width}" height="${overviewFrame.height}" rx="12"/>
  ${gridLines(overviewFrame, 5, 5, "grid")}
  <g clip-path="url(#overview-clip)">
    <path d="${linePath(fullRawScreen)}" class="overview-raw"/>
    <path d="${linePath(fullKalmanScreen)}" class="overview-kalman"/>
    <path d="${linePath(detailOverviewScreen)}" class="detail-highlight"/>
    ${overviewMarkers}
  </g>
  <circle cx="${formatNumber(overviewStart[0], 2)}" cy="${formatNumber(overviewStart[1], 2)}" r="7" class="endpoint start"/>
  <circle cx="${formatNumber(overviewEnd[0], 2)}" cy="${formatNumber(overviewEnd[1], 2)}" r="7" class="endpoint end"/>

  <text class="panel-title" x="${detailFrame.x}" y="${detailFrame.y - 34}">2. DETAIL AIS vs KALMAN</text>
  <text class="panel-note" x="${detailFrame.x}" y="${detailFrame.y - 12}">Label diringkas dan dipindahkan otomatis agar tidak bertumpuk.</text>
  <rect class="panel" x="${detailFrame.x}" y="${detailFrame.y}" width="${detailFrame.width}" height="${detailFrame.height}" rx="12"/>
  ${gridLines(detailFrame, 7, 5, "grid")}
  <g clip-path="url(#detail-clip)">
    ${detailCorrections}
    <path d="${linePath(detailRawScreen)}" class="raw-line"/>
    <path d="${linePath(detailKalmanScreen)}" class="kalman-line"/>
    ${detailRawMarkers}
    ${detailKalmanMarkers}
    ${labels}
  </g>
  <rect class="badge" x="${detailFrame.x + detailFrame.width - 315}" y="${detailFrame.y + 18}" width="285" height="58" rx="9"/>
  <text class="badge-text" x="${detailFrame.x + detailFrame.width - 295}" y="${detailFrame.y + 43}">Median: ${escapeXml(formatDistance(medianResidualM))}</text>
  <text class="badge-text" x="${detailFrame.x + detailFrame.width - 295}" y="${detailFrame.y + 65}">Maksimum: ${escapeXml(formatDistance(maxResidualM))} pada T${maxResidualIndex + 1}</text>

  <text class="panel-title" x="${residualFrame.x}" y="${residualFrame.y - 34}">3. BESAR PERBEDAAN AIS-KALMAN</text>
  <text class="panel-note" x="${residualFrame.x}" y="${residualFrame.y - 12}">Jarak langsung antara posisi AIS dan estimasi Kalman pada setiap timestamp, dalam meter.</text>
  <rect class="panel" x="${residualFrame.x}" y="${residualFrame.y}" width="${residualFrame.width}" height="${residualFrame.height}" rx="12"/>
  ${residualGrid.join("\n  ")}
  <g clip-path="url(#residual-clip)">
    <path d="${areaPath(residualScreen, residualPlot.y + residualPlot.height)}" class="residual-area"/>
    <path d="${linePath(residualScreen)}" class="residual-line"/>
    ${residualDots}
  </g>
  ${residualTicks}

  <line x1="75" y1="1098" x2="145" y2="1098" class="raw-line"/>
  <text x="160" y="1104" class="legend-text">AIS ASLI</text>
  <line x1="290" y1="1098" x2="360" y2="1098" class="kalman-line"/>
  <text x="375" y="1104" class="legend-text">ESTIMASI KALMAN</text>
  <line x1="575" y1="1098" x2="645" y2="1098" class="correction"/>
  <text x="660" y="1104" class="legend-text">JARAK/KOREKSI</text>
  <line x1="875" y1="1098" x2="945" y2="1098" class="detail-highlight"/>
  <text x="960" y="1104" class="legend-text">WINDOW DETAIL</text>
  <circle cx="1180" cy="1098" r="7" class="endpoint start"/>
  <text x="1195" y="1104" class="legend-text">MULAI</text>
  <circle cx="1295" cy="1098" r="7" class="endpoint end"/>
  <text x="1310" y="1104" class="legend-text">SELESAI</text>
  <text x="55" y="1150" class="panel-note">Catatan: semua vertex berasal dari observasi nyata; tidak ada interpolasi, resampling, atau titik sintetis.</text>
</svg>
`;
}

function insetFrame(frame, horizontal, vertical) {
  return {
    x: frame.x + horizontal,
    y: frame.y + vertical,
    width: Math.max(1, frame.width - horizontal * 2),
    height: Math.max(1, frame.height - vertical * 2),
  };
}

function areaPath(points, baselineY) {
  if (!points.length) return "";
  const start = points[0];
  const end = points.at(-1);
  return `M ${formatNumber(start[0], 2)} ${formatNumber(baselineY, 2)} L ${points
    .map(([x, y]) => `${formatNumber(x, 2)} ${formatNumber(y, 2)}`)
    .join(" L ")} L ${formatNumber(end[0], 2)} ${formatNumber(baselineY, 2)} Z`;
}

function renderCollisionAvoidingLabels(rawScreen, kalmanScreen, indexes, frame) {
  const placed = [];
  const offsets = [
    [15, -32],
    [-58, -32],
    [15, 42],
    [-58, 42],
    [35, 5],
    [-78, 5],
    [0, -58],
    [0, 68],
  ];
  return indexes
    .map((index) => {
      const raw = rawScreen[index];
      const kalman = kalmanScreen[index];
      const pointX = (raw[0] + kalman[0]) / 2;
      const pointY = (raw[1] + kalman[1]) / 2;
      const text = `T${index + 1}`;
      const width = 18 + text.length * 8;
      const height = 24;
      let best = null;
      for (const [offsetX, offsetY] of offsets) {
        const x = Math.min(frame.x + frame.width - width, Math.max(frame.x, pointX + offsetX));
        const y = Math.min(frame.y + frame.height - height, Math.max(frame.y, pointY + offsetY - height / 2));
        const box = { x, y, width, height };
        const collisions = placed.filter((other) => boxesOverlap(box, other)).length;
        const score = collisions * 10000 + Math.hypot(x + width / 2 - pointX, y + height / 2 - pointY);
        if (!best || score < best.score) best = { ...box, score };
        if (collisions === 0) break;
      }
      placed.push(best);
      const labelX = best.x + best.width / 2;
      const labelY = best.y + 16;
      return `<line x1="${formatNumber(pointX, 2)}" y1="${formatNumber(pointY, 2)}" x2="${formatNumber(labelX, 2)}" y2="${formatNumber(best.y + best.height / 2, 2)}" class="label-leader"/>
      <rect x="${formatNumber(best.x, 2)}" y="${formatNumber(best.y, 2)}" width="${formatNumber(best.width, 2)}" height="${best.height}" rx="5" class="label-box"/>
      <text x="${formatNumber(labelX, 2)}" y="${formatNumber(labelY, 2)}" text-anchor="middle" class="point-label">${text}</text>`;
    })
    .join("\n");
}

function boxesOverlap(a, b) {
  const padding = 4;
  return !(
    a.x + a.width + padding < b.x ||
    b.x + b.width + padding < a.x ||
    a.y + a.height + padding < b.y ||
    b.y + b.height + padding < a.y
  );
}

function renderSvg(track, stats) {
  const width = 1300;
  const height = 1050;
  const frame = { x: 55, y: 78, width: 1190, height: 835 };
  const legend = { x: 55, y: 940, width: 1190, height: 70 };
  const refLat = track.items[0].lat;
  const refLon = track.items[0].lon;
  const rawProjected = track.items.map((item) => projectToMeters(item.lat, item.lon, refLat, refLon));
  const kalmanProjected = track.items.map((item) =>
    projectToMeters(item.kalmanLat, item.kalmanLon, refLat, refLon));
  const residualDistances = rawProjected
    .map((point, index) =>
      Math.hypot(point.x - kalmanProjected[index].x, point.y - kalmanProjected[index].y))
    .filter((distance) => distance > 1e-6)
    .sort((a, b) => a - b);
  const trackSpanM = projectedSpanM([...rawProjected, ...kalmanProjected]);
  const referenceResidualM = residualDistances.length
    ? residualDistances[Math.floor((residualDistances.length - 1) * 0.75)]
    : 0;
  const residualAmplification = referenceResidualM > 0
    ? Math.min(2500, Math.max(1, (trackSpanM * 0.012) / referenceResidualM))
    : 1;
  const displayRawProjected = rawProjected.map((point, index) => ({
    x: kalmanProjected[index].x + (point.x - kalmanProjected[index].x) * residualAmplification,
    y: kalmanProjected[index].y + (point.y - kalmanProjected[index].y) * residualAmplification,
  }));
  const viewport = fitViewport(
    [...displayRawProjected, ...kalmanProjected],
    { x: frame.x + 40, y: frame.y + 35, width: frame.width - 80, height: frame.height - 70 },
    0.05,
    100,
  );
  const rawScreen = displayRawProjected.map((point) => viewport.map(point));
  const kalmanScreen = kalmanProjected.map((point) => viewport.map(point));
  const corrections = rawScreen
    .map(([x1, y1], index) => {
      const [x2, y2] = kalmanScreen[index];
      const screenDistance = Math.hypot(x2 - x1, y2 - y1);
      if (screenDistance < 1.5) return "";
      return `<line x1="${formatNumber(x1, 2)}" y1="${formatNumber(y1, 2)}" x2="${formatNumber(x2, 2)}" y2="${formatNumber(y2, 2)}" class="correction"/>`;
    })
    .filter(Boolean)
    .join("\n");
  const rawMarkers = rawScreen
    .map(([x, y]) =>
      `<circle cx="${formatNumber(x, 2)}" cy="${formatNumber(y, 2)}" r="2.2" class="raw-point"/>`)
    .join("\n");
  const kalmanMarkers = kalmanScreen
    .map(([x, y]) =>
      `<circle cx="${formatNumber(x, 2)}" cy="${formatNumber(y, 2)}" r="1.7" class="kalman-point"/>`)
    .join("\n");
  const grid = gridLines(frame, 6, 6, "grid");
  const start = kalmanScreen[0];
  const end = kalmanScreen.at(-1);
  const sourcePointCount = track.sourcePointCount ?? track.items.length;
  const sequenceLabel = sequenceLimitPerTrack > 0
    ? (
      sequenceScope === "mmsi"
        ? `${track.items.length} SEQUENCE PER MMSI DARI ${sourcePointCount} TITIK SUMBER`
        : `${track.items.length} SEQUENCE DARI ${sourcePointCount} TITIK SUMBER`
    )
    : `SELURUH ${track.items.length} TITIK`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <clipPath id="plot-clip"><rect x="${frame.x}" y="${frame.y}" width="${frame.width}" height="${frame.height}"/></clipPath>
  </defs>
  <style>
    .bg { fill: #f4f9ff; }
    .frame { fill: none; stroke: #0b4aaa; stroke-width: 4; }
    .grid { stroke: #b7d9fb; stroke-width: 1.4; stroke-dasharray: 6 8; }
    .title { fill: #002b6f; font: 18px monospace; }
    .subtitle { fill: #365b88; font: 14px monospace; }
    .kalman-halo { fill: none; stroke: #ffffff; stroke-width: 10; stroke-linecap: round; stroke-linejoin: round; opacity: 0.95; }
    .kalman-line { fill: none; stroke: #0066e8; stroke-width: 6; stroke-linecap: round; stroke-linejoin: round; }
    .raw-line { fill: none; stroke: #ff2020; stroke-width: 5; stroke-linecap: round; stroke-linejoin: round; stroke-dasharray: 11 9; }
    .correction { stroke: #707070; stroke-width: 1.4; stroke-dasharray: 4 5; opacity: 0.55; }
    .raw-point { fill: #ffffff; stroke: #ff2020; stroke-width: 1.1; }
    .kalman-point { fill: #0087ff; stroke: #003d99; stroke-width: 0.7; }
    .endpoint { stroke: #082f5b; stroke-width: 2; }
    .start { fill: #18a558; }
    .end { fill: #ffb000; }
    .legend-text { fill: #1d1d1d; font: 16px monospace; }
  </style>
  <rect class="bg" width="${width}" height="${height}"/>
  <text class="title" x="${frame.x}" y="28">MMSI: ${escapeXml(track.mmsi)} | ${track.items[0].time.toISOString()} - ${track.items.at(-1).time.toISOString()}</text>
  <text class="subtitle" x="${frame.x}" y="52">${escapeXml(track.vesselName)} | ${escapeXml(track.gearLabel)} | ${sequenceLabel} | SELISIH AIS-KALMAN DIPERBESAR ${formatNumber(residualAmplification, 1)}x</text>
  <rect class="frame" x="${frame.x}" y="${frame.y}" width="${frame.width}" height="${frame.height}"/>
  ${grid}
  <g clip-path="url(#plot-clip)">
    ${corrections}
    <path d="${linePath(kalmanScreen)}" class="kalman-halo"/>
    <path d="${linePath(kalmanScreen)}" class="kalman-line"/>
    <path d="${linePath(rawScreen)}" class="raw-line"/>
    ${kalmanMarkers}
    ${rawMarkers}
  </g>
  <circle cx="${formatNumber(start[0], 2)}" cy="${formatNumber(start[1], 2)}" r="7" class="endpoint start"/>
  <circle cx="${formatNumber(end[0], 2)}" cy="${formatNumber(end[1], 2)}" r="7" class="endpoint end"/>
  <rect class="frame" x="${legend.x}" y="${legend.y}" width="${legend.width}" height="${legend.height}"/>
  <line x1="90" y1="975" x2="160" y2="975" class="raw-line"/>
  <text x="180" y="981" class="legend-text">AIS INPUT MENTAH</text>
  <line x1="410" y1="975" x2="490" y2="975" class="kalman-line"/>
  <text x="510" y="981" class="legend-text">AIS HASIL KALMAN</text>
  <line x1="760" y1="975" x2="830" y2="975" class="correction"/>
  <text x="850" y="981" class="legend-text">KOREKSI (MAGNIFIKASI ${formatNumber(residualAmplification, 1)}x)</text>
  <circle cx="1090" cy="975" r="7" class="endpoint start"/>
  <text x="1110" y="981" class="legend-text">MULAI</text>
  <circle cx="1190" cy="975" r="7" class="endpoint end"/>
  <text x="1210" y="981" class="legend-text">SELESAI</text>
</svg>
`;
}

function renderSvgSequence(track, stats) {
  const width = 1600;
  const height = 760;
  const frame = { x: 24, y: 58, width: 1552, height: 600 };
  const legend = { x: 24, y: 682, width: 1552, height: 54 };
  const displayItems = selectObservedWindow(track.items, 38);
  const refLat = displayItems[0].lat;
  const refLon = displayItems[0].lon;
  const rawProjected = displayItems.map((item) => projectToMeters(item.lat, item.lon, refLat, refLon));
  const kalmanProjected = displayItems.map((item) =>
    projectToMeters(item.kalmanLat, item.kalmanLon, refLat, refLon));
  const rotation = routeRotation(rawProjected);
  const rawRotated = rawProjected.map((point) => rotatePoint(point, rotation));
  const kalmanRotated = kalmanProjected.map((point) => rotatePoint(point, rotation));
  const viewport = independentAxisViewport(
    [...rawRotated, ...kalmanRotated],
    { x: frame.x + 76, y: frame.y + 55, width: frame.width - 150, height: frame.height - 110 },
  );
  const rawScreen = rawRotated.map((point) => viewport.map(point));
  const kalmanScreen = kalmanRotated.map((point) => viewport.map(point));
  const corrections = rawScreen
    .map(([x1, y1], index) => {
      const [x2, y2] = kalmanScreen[index];
      return `<line x1="${formatNumber(x1, 2)}" y1="${formatNumber(y1, 2)}" x2="${formatNumber(x2, 2)}" y2="${formatNumber(y2, 2)}" class="correction"/>`;
    })
    .join("\n");
  const rawMarkers = rawScreen
    .map(([x, y]) =>
      `<circle cx="${formatNumber(x, 2)}" cy="${formatNumber(y, 2)}" r="6.3" class="raw-point"/>`)
    .join("\n");
  const kalmanMarkers = kalmanScreen
    .map(([x, y]) =>
      `<circle cx="${formatNumber(x, 2)}" cy="${formatNumber(y, 2)}" r="5.2" class="kalman-point"/>`)
    .join("\n");
  const labels = rawScreen
    .map(([x, rawY], index) => {
      const kalmanY = kalmanScreen[index][1];
      const baseline = index % 2 === 0 ? Math.min(rawY, kalmanY) - 21 : Math.max(rawY, kalmanY) + 28;
      const labelX = Math.min(frame.x + frame.width - 40, Math.max(frame.x + 12, x + (index % 2 === 0 ? 5 : -16)));
      const labelY = Math.min(frame.y + frame.height - 10, Math.max(frame.y + 22, baseline));
      return `<text x="${formatNumber(labelX, 2)}" y="${formatNumber(labelY, 2)}" class="point-label">T${index + 1}</text>`;
    })
    .join("\n");
  const grid = gridLines(frame, 8, 7, "grid");
  const fullStart = track.items[0].time.toISOString();
  const fullEnd = track.items.at(-1).time.toISOString();
  const windowStart = displayItems[0].time.toISOString();
  const windowEnd = displayItems.at(-1).time.toISOString();

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <style>
    .bg { fill: #f4f9ff; }
    .frame { fill: none; stroke: #0b4aaa; stroke-width: 4; }
    .grid { stroke: #9dccff; stroke-width: 2; stroke-dasharray: 6 8; }
    .title { fill: #002b6f; font: 18px monospace; }
    .subtitle { fill: #365b88; font: 13px monospace; }
    .raw-line { fill: none; stroke: #ff2020; stroke-width: 7; stroke-linecap: round; stroke-linejoin: round; stroke-dasharray: 10 10; }
    .kalman-line { fill: none; stroke: #0066e8; stroke-width: 8; stroke-linecap: round; stroke-linejoin: round; }
    .correction { stroke: #6d6d6d; stroke-width: 3; stroke-dasharray: 5 7; opacity: 0.85; }
    .raw-point { fill: #ffffff; stroke: #111111; stroke-width: 1.2; }
    .kalman-point { fill: #0087ff; stroke: #003d99; stroke-width: 1.4; }
    .point-label { fill: #002b6f; font: 16px monospace; }
    .legend-text { fill: #1d1d1d; font: 17px monospace; }
  </style>
  <rect class="bg" width="${width}" height="${height}"/>
  <text class="title" x="${frame.x}" y="25">MMSI: ${escapeXml(track.mmsi)} | ${windowStart} - ${windowEnd}</text>
  <text class="subtitle" x="${frame.x}" y="45">${escapeXml(track.vesselName)} | ${escapeXml(track.gearLabel)} | ${displayItems.length} observasi aktual ditampilkan dari ${track.items.length} titik (${fullStart} - ${fullEnd})</text>
  <rect class="frame" x="${frame.x}" y="${frame.y}" width="${frame.width}" height="${frame.height}"/>
  ${grid}
  ${corrections}
  <path d="${linePath(rawScreen)}" class="raw-line"/>
  <path d="${linePath(kalmanScreen)}" class="kalman-line"/>
  ${rawMarkers}
  ${kalmanMarkers}
  ${labels}
  <rect class="frame" x="${legend.x}" y="${legend.y}" width="${legend.width}" height="${legend.height}"/>
  <line x1="70" y1="709" x2="135" y2="709" class="raw-line"/>
  <text x="150" y="715" class="legend-text">TRAJECTORY AIS MENTAH</text>
  <line x1="385" y1="709" x2="460" y2="709" class="kalman-line"/>
  <text x="475" y="715" class="legend-text">TRAJECTORY HASIL KALMAN</text>
  <circle cx="760" cy="709" r="7" class="raw-point"/>
  <text x="780" y="715" class="legend-text">TITIK OBSERVASI AIS</text>
  <line x1="1050" y1="709" x2="1120" y2="709" class="correction"/>
  <text x="1140" y="715" class="legend-text">KOREKSI / PENYESUAIAN KALMAN</text>
</svg>
`;
}

function renderSvgZoom(track, stats) {
  const width = 1800;
  const height = 1050;
  const mainFrame = { x: 70, y: 125, width: 1080, height: 770 };
  const zoomFrame = { x: 1190, y: 125, width: 540, height: 770 };
  const refLat = track.items[0].lat;
  const refLon = track.items[0].lon;
  const rawProjected = track.items.map((item) => projectToMeters(item.lat, item.lon, refLat, refLon));
  const kalmanProjected = track.items.map((item) => projectToMeters(item.kalmanLat, item.kalmanLon, refLat, refLon));
  const shifts = rawProjected.map((point, index) =>
    Math.hypot(point.x - kalmanProjected[index].x, point.y - kalmanProjected[index].y));
  const sortedShifts = shifts.toSorted((a, b) => a - b);
  const medianShiftM = sortedShifts[Math.floor((sortedShifts.length - 1) / 2)] ?? 0;
  const maxShiftM = Math.max(...shifts);
  const maxShiftIndex = shifts.indexOf(maxShiftM);
  const maxRaw = rawProjected[maxShiftIndex];
  const maxKalman = kalmanProjected[maxShiftIndex];

  const mainViewport = fitViewport([...rawProjected, ...kalmanProjected], mainFrame, 0.06, 500);
  const rawScreen = rawProjected.map((point) => mainViewport.map(point));
  const kalmanScreen = kalmanProjected.map((point) => mainViewport.map(point));

  const zoomCenter = {
    x: (maxRaw.x + maxKalman.x) / 2,
    y: (maxRaw.y + maxKalman.y) / 2,
  };
  const zoomSpanX = Math.max(100, maxShiftM * 7);
  const zoomSpanY = zoomSpanX * (zoomFrame.height / zoomFrame.width);
  const zoomViewport = fixedViewport(zoomCenter, zoomSpanX, zoomSpanY, zoomFrame);
  const rawZoomScreen = rawProjected.map((point) => zoomViewport.map(point));
  const kalmanZoomScreen = kalmanProjected.map((point) => zoomViewport.map(point));

  const markerStep = Math.max(1, Math.ceil(track.items.length / 120));
  const rawMarkers = rawScreen
    .filter((_, index) => index === 0 || index === rawScreen.length - 1 || index % markerStep === 0)
    .map(([x, y]) => `<circle cx="${formatNumber(x, 2)}" cy="${formatNumber(y, 2)}" r="3.2" class="raw-point"/>`)
    .join("\n");
  const correctionStep = Math.max(1, Math.ceil(track.items.length / 400));
  const zoomCorrections = rawZoomScreen
    .map(([x1, y1], index) => ({
      index,
      x1,
      y1,
      x2: kalmanZoomScreen[index][0],
      y2: kalmanZoomScreen[index][1],
    }))
    .filter((point) =>
      point.index === maxShiftIndex ||
      (
        point.index % correctionStep === 0 &&
        (
          insideFrame(point.x1, point.y1, zoomFrame) ||
          insideFrame(point.x2, point.y2, zoomFrame)
        )
      ))
    .map((point) =>
      `<line x1="${formatNumber(point.x1, 2)}" y1="${formatNumber(point.y1, 2)}" x2="${formatNumber(point.x2, 2)}" y2="${formatNumber(point.y2, 2)}" class="${point.index === maxShiftIndex ? "max-correction" : "correction"}"/>`)
    .join("\n");
  const start = rawScreen[0];
  const end = rawScreen.at(-1);
  const mainGrid = gridLines(mainFrame, 6, 5, "grid");
  const zoomGrid = gridLines(zoomFrame, 4, 4, "grid zoom-grid");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <clipPath id="main-clip"><rect x="${mainFrame.x}" y="${mainFrame.y}" width="${mainFrame.width}" height="${mainFrame.height}"/></clipPath>
    <clipPath id="zoom-clip"><rect x="${zoomFrame.x}" y="${zoomFrame.y}" width="${zoomFrame.width}" height="${zoomFrame.height}"/></clipPath>
  </defs>
  <style>
    .bg { fill: #f7fbff; }
    .frame { fill: #ffffff; stroke: #164e8a; stroke-width: 3; }
    .grid { stroke: #d4e6f7; stroke-width: 1.5; stroke-dasharray: 6 8; }
    .zoom-grid { stroke: #c7d9e8; stroke-width: 1; }
    .title { fill: #082f5b; font: bold 22px Arial, sans-serif; }
    .subtitle { fill: #294d70; font: 17px Arial, sans-serif; }
    .panel-title { fill: #082f5b; font: bold 18px Arial, sans-serif; }
    .panel-note { fill: #294d70; font: 15px Arial, sans-serif; }
    .kalman-line { fill: none; stroke: #0066e8; stroke-width: 3.2; stroke-linecap: round; stroke-linejoin: round; opacity: 0.95; }
    .raw-line { fill: none; stroke: #e31a1c; stroke-width: 5; stroke-linecap: round; stroke-linejoin: round; stroke-dasharray: 10 8; opacity: 0.9; }
    .raw-point { fill: #ff3030; stroke: #8b0000; stroke-width: 0.8; }
    .kalman-point { fill: #0066e8; stroke: #003b82; stroke-width: 1; }
    .correction { stroke: #4b5563; stroke-width: 1.4; stroke-dasharray: 4 4; opacity: 0.65; }
    .max-correction { stroke: #111827; stroke-width: 3.2; stroke-dasharray: 7 5; }
    .endpoint { stroke: #111827; stroke-width: 2; }
    .start { fill: #18a558; }
    .end { fill: #ffb000; }
    .legend { fill: #ffffff; stroke: #164e8a; stroke-width: 2; }
    .legend-text { fill: #172b3f; font: 17px Arial, sans-serif; }
  </style>
  <rect class="bg" width="${width}" height="${height}"/>
  <text class="title" x="70" y="38">${escapeXml(track.vesselName)} | MMSI ${escapeXml(track.mmsi)} | ${escapeXml(track.gearLabel)}</text>
  <text class="subtitle" x="70" y="68">${escapeXml(track.trackId)} | ${track.items.length} AIS points | ${track.items[0].time.toISOString()} – ${track.items.at(-1).time.toISOString()}</text>
  <text class="subtitle" x="70" y="96">Median selisih ${formatDistance(medianShiftM)} | maksimum ${formatDistance(maxShiftM)} pada T${maxShiftIndex + 1} | koordinat tidak digeser untuk visualisasi</text>
  <text class="panel-title" x="${mainFrame.x}" y="${mainFrame.y - 14}">LINTASAN PENUH</text>
  <rect class="frame" x="${mainFrame.x}" y="${mainFrame.y}" width="${mainFrame.width}" height="${mainFrame.height}"/>
  ${mainGrid}
  <g clip-path="url(#main-clip)">
    <path d="${linePath(rawScreen)}" class="raw-line"/>
    <path d="${linePath(kalmanScreen)}" class="kalman-line"/>
    ${rawMarkers}
  </g>
  <circle cx="${formatNumber(start[0], 2)}" cy="${formatNumber(start[1], 2)}" r="8" class="endpoint start"/>
  <circle cx="${formatNumber(end[0], 2)}" cy="${formatNumber(end[1], 2)}" r="8" class="endpoint end"/>
  <text class="panel-title" x="${zoomFrame.x}" y="${zoomFrame.y - 38}">ZOOM KOREKSI TERBESAR — T${maxShiftIndex + 1}</text>
  <text class="panel-note" x="${zoomFrame.x}" y="${zoomFrame.y - 14}">Lebar area ${formatDistance(zoomSpanX)}; garis abu-abu menghubungkan AIS ke estimasi Kalman.</text>
  <rect class="frame" x="${zoomFrame.x}" y="${zoomFrame.y}" width="${zoomFrame.width}" height="${zoomFrame.height}"/>
  ${zoomGrid}
  <g clip-path="url(#zoom-clip)">
    <path d="${linePath(rawZoomScreen)}" class="raw-line"/>
    <path d="${linePath(kalmanZoomScreen)}" class="kalman-line"/>
    ${zoomCorrections}
    <circle cx="${formatNumber(rawZoomScreen[maxShiftIndex][0], 2)}" cy="${formatNumber(rawZoomScreen[maxShiftIndex][1], 2)}" r="8" class="raw-point"/>
    <circle cx="${formatNumber(kalmanZoomScreen[maxShiftIndex][0], 2)}" cy="${formatNumber(kalmanZoomScreen[maxShiftIndex][1], 2)}" r="8" class="kalman-point"/>
  </g>
  <rect class="legend" x="70" y="${height - 110}" width="1660" height="72" rx="8"/>
  <line x1="105" y1="${height - 74}" x2="195" y2="${height - 74}" class="raw-line"/>
  <text class="legend-text" x="215" y="${height - 68}">AIS INPUT ASLI</text>
  <line x1="420" y1="${height - 74}" x2="510" y2="${height - 74}" class="kalman-line"/>
  <text class="legend-text" x="530" y="${height - 68}">HASIL KALMAN</text>
  <line x1="755" y1="${height - 74}" x2="845" y2="${height - 74}" class="correction"/>
  <text class="legend-text" x="865" y="${height - 68}">SELISIH/KOREKSI</text>
  <circle cx="1120" cy="${height - 74}" r="8" class="endpoint start"/>
  <text class="legend-text" x="1140" y="${height - 68}">MULAI</text>
  <circle cx="1270" cy="${height - 74}" r="8" class="endpoint end"/>
  <text class="legend-text" x="1290" y="${height - 68}">SELESAI</text>
  <text class="legend-text" x="1430" y="${height - 68}">Semua vertex memakai data sebenarnya.</text>
</svg>
`;
}

function renderSvgLegacy(track, stats) {
  const width = 1600;
  const height = 900;
  const margin = { left: 85, right: 65, top: 105, bottom: 145 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const refLat = track.items[0].lat;
  const refLon = track.items[0].lon;
  const rawProjected = track.items.map((item) => projectToMeters(item.lat, item.lon, refLat, refLon));
  const kalmanProjected = track.items.map((item) => projectToMeters(item.kalmanLat, item.kalmanLon, refLat, refLon));
  const allX = [...rawProjected, ...kalmanProjected].map((point) => point.x);
  const allY = [...rawProjected, ...kalmanProjected].map((point) => point.y);
  let minX = Math.min(...allX);
  let maxX = Math.max(...allX);
  let minY = Math.min(...allY);
  let maxY = Math.max(...allY);
  if (Math.abs(maxX - minX) < 1) {
    minX -= 500;
    maxX += 500;
  }
  if (Math.abs(maxY - minY) < 1) {
    minY -= 500;
    maxY += 500;
  }
  const xPad = (maxX - minX) * 0.06;
  const yPad = (maxY - minY) * 0.06;
  minX -= xPad;
  maxX += xPad;
  minY -= yPad;
  maxY += yPad;

  const scale = Math.min(plotWidth / (maxX - minX), plotHeight / (maxY - minY));
  const drawWidth = (maxX - minX) * scale;
  const drawHeight = (maxY - minY) * scale;
  const offsetX = margin.left + (plotWidth - drawWidth) / 2;
  const offsetY = margin.top + (plotHeight - drawHeight) / 2;
  const sx = (x) => offsetX + (x - minX) * scale;
  const sy = (y) => offsetY + drawHeight - (y - minY) * scale;
  const rawScreen = rawProjected.map((point) => [sx(point.x), sy(point.y)]);
  const kalmanScreen = kalmanProjected.map((point) => [sx(point.x), sy(point.y)]);
  const markerStep = Math.max(1, Math.ceil(track.items.length / 120));
  const rawMarkers = rawScreen
    .filter((_, index) => index === 0 || index === rawScreen.length - 1 || index % markerStep === 0)
    .map(([x, y]) => `<circle cx="${formatNumber(x, 2)}" cy="${formatNumber(y, 2)}" r="3.2" class="raw-point"/>`)
    .join("\n");
  const start = rawScreen[0];
  const end = rawScreen.at(-1);
  const grid = [];
  for (let i = 0; i <= 6; i += 1) {
    const x = margin.left + (plotWidth * i) / 6;
    grid.push(`<line x1="${x}" y1="${margin.top}" x2="${x}" y2="${margin.top + plotHeight}" class="grid"/>`);
  }
  for (let i = 0; i <= 5; i += 1) {
    const y = margin.top + (plotHeight * i) / 5;
    grid.push(`<line x1="${margin.left}" y1="${y}" x2="${margin.left + plotWidth}" y2="${y}" class="grid"/>`);
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <style>
    .bg { fill: #f7fbff; }
    .frame { fill: #ffffff; stroke: #164e8a; stroke-width: 3; }
    .grid { stroke: #d4e6f7; stroke-width: 1.5; stroke-dasharray: 6 8; }
    .title { fill: #082f5b; font: bold 22px Arial, sans-serif; }
    .subtitle { fill: #294d70; font: 17px Arial, sans-serif; }
    .kalman-line { fill: none; stroke: #0066e8; stroke-width: 5.5; stroke-linecap: round; stroke-linejoin: round; opacity: 0.9; }
    .raw-line { fill: none; stroke: #e31a1c; stroke-width: 3; stroke-linecap: round; stroke-linejoin: round; stroke-dasharray: 9 7; }
    .raw-point { fill: #ff3030; stroke: #8b0000; stroke-width: 0.8; }
    .endpoint { stroke: #111827; stroke-width: 2; }
    .start { fill: #18a558; }
    .end { fill: #ffb000; }
    .legend { fill: #ffffff; stroke: #164e8a; stroke-width: 2; }
    .legend-text { fill: #172b3f; font: 17px Arial, sans-serif; }
  </style>
  <rect class="bg" width="${width}" height="${height}"/>
  <text class="title" x="${margin.left}" y="38">${escapeXml(track.vesselName)} | MMSI ${escapeXml(track.mmsi)} | ${escapeXml(track.gearLabel)}</text>
  <text class="subtitle" x="${margin.left}" y="68">${escapeXml(track.trackId)} | ${track.items.length} AIS points | ${track.items[0].time.toISOString()} – ${track.items.at(-1).time.toISOString()}</text>
  <text class="subtitle" x="${margin.left}" y="91">Distance ${(stats.totalDistanceM / 1000).toFixed(1)} km | displacement ${(stats.displacementM / 1000).toFixed(1)} km | red = AIS input, blue = Kalman</text>
  <rect class="frame" x="${margin.left}" y="${margin.top}" width="${plotWidth}" height="${plotHeight}"/>
  ${grid.join("\n  ")}
  <path d="${linePath(kalmanScreen)}" class="kalman-line"/>
  <path d="${linePath(rawScreen)}" class="raw-line"/>
  ${rawMarkers}
  <circle cx="${formatNumber(start[0], 2)}" cy="${formatNumber(start[1], 2)}" r="8" class="endpoint start"/>
  <circle cx="${formatNumber(end[0], 2)}" cy="${formatNumber(end[1], 2)}" r="8" class="endpoint end"/>
  <rect class="legend" x="${margin.left}" y="${height - 105}" width="${plotWidth}" height="70" rx="8"/>
  <line x1="${margin.left + 35}" y1="${height - 72}" x2="${margin.left + 125}" y2="${height - 72}" class="raw-line"/>
  <text class="legend-text" x="${margin.left + 145}" y="${height - 66}">AIS INPUT (semua timestamp/lat/lon asli)</text>
  <line x1="${margin.left + 545}" y1="${height - 72}" x2="${margin.left + 635}" y2="${height - 72}" class="kalman-line"/>
  <text class="legend-text" x="${margin.left + 655}" y="${height - 66}">HASIL KALMAN</text>
  <circle cx="${margin.left + 925}" cy="${height - 72}" r="8" class="endpoint start"/>
  <text class="legend-text" x="${margin.left + 945}" y="${height - 66}">MULAI</text>
  <circle cx="${margin.left + 1060}" cy="${height - 72}" r="8" class="endpoint end"/>
  <text class="legend-text" x="${margin.left + 1080}" y="${height - 66}">SELESAI</text>
  <text class="legend-text" x="${margin.left + 1195}" y="${height - 66}">Marker merah diringkas; garis memakai seluruh titik.</text>
</svg>
`;
}

function selectObservedWindow(items, maximumPoints) {
  if (items.length <= maximumPoints) return items;
  let bestStart = 0;
  let bestScore = -Infinity;
  for (let start = 0; start <= items.length - maximumPoints; start += 1) {
    const window = items.slice(start, start + maximumPoints);
    const score = detailWindowScore(window);
    if (score > bestScore) {
      bestScore = score;
      bestStart = start;
    }
  }
  return items.slice(bestStart, bestStart + maximumPoints);
}

function detailWindowScore(items) {
  const corrections = items
    .map((item) => haversineM(item.lat, item.lon, item.kalmanLat, item.kalmanLon))
    .filter(Number.isFinite)
    .toSorted((a, b) => a - b);
  const p75CorrectionM = corrections[Math.floor((corrections.length - 1) * 0.75)] ?? 0;
  const maxCorrectionM = corrections.at(-1) ?? 0;
  let totalDistanceM = 0;
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  const uniqueCoordinates = new Set();
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    minLat = Math.min(minLat, item.lat);
    maxLat = Math.max(maxLat, item.lat);
    minLon = Math.min(minLon, item.lon);
    maxLon = Math.max(maxLon, item.lon);
    uniqueCoordinates.add(`${item.lat.toFixed(6)}|${item.lon.toFixed(6)}`);
    if (index > 0) {
      totalDistanceM += haversineM(items[index - 1].lat, items[index - 1].lon, item.lat, item.lon);
    }
  }
  const spatialSpanM = haversineM(minLat, minLon, maxLat, maxLon);
  const uniqueRatio = uniqueCoordinates.size / items.length;
  const visibilityRatio = p75CorrectionM / Math.max(100, spatialSpanM);
  const movementScore = Math.log1p(Math.max(spatialSpanM, totalDistanceM * 0.15));
  const correctionScore = Math.log1p(p75CorrectionM * 0.75 + maxCorrectionM * 0.25);
  const duplicatePenalty = uniqueRatio < 0.6 ? (0.6 - uniqueRatio) * 8 : 0;
  return correctionScore * 1.5 +
    movementScore * 0.8 +
    Math.min(2, visibilityRatio) * 2.5 +
    uniqueRatio * 2 -
    duplicatePenalty;
}

function selectSequenceItems(items, maximumPoints, strategy) {
  if (items.length <= maximumPoints) return items;
  if (strategy === "residual-window") return selectObservedWindow(items, maximumPoints);
  if (strategy === "even-index") return selectEvenIndexItems(items, maximumPoints);
  return selectDistanceSpreadItems(items, maximumPoints);
}

function selectDistanceSpreadItems(items, maximumPoints) {
  if (items.length <= maximumPoints) return items;
  const cumulative = [0];
  for (let i = 1; i < items.length; i += 1) {
    cumulative.push(cumulative[i - 1] + haversineM(items[i - 1].lat, items[i - 1].lon, items[i].lat, items[i].lon));
  }
  const totalDistance = cumulative.at(-1);
  if (!Number.isFinite(totalDistance) || totalDistance <= 0) return selectEvenIndexItems(items, maximumPoints);

  const selectedIndexes = new Set();
  for (let i = 0; i < maximumPoints; i += 1) {
    const targetDistance = (totalDistance * i) / (maximumPoints - 1);
    const nearest = nearestUnusedDistanceIndex(cumulative, targetDistance, selectedIndexes);
    selectedIndexes.add(nearest);
  }
  return [...selectedIndexes]
    .sort((a, b) => a - b)
    .map((index) => items[index]);
}

function selectEvenIndexItems(items, maximumPoints) {
  if (items.length <= maximumPoints) return items;
  const selectedIndexes = new Set();
  for (let i = 0; i < maximumPoints; i += 1) {
    const targetIndex = Math.round(((items.length - 1) * i) / (maximumPoints - 1));
    selectedIndexes.add(nearestUnusedIndex(items.length, targetIndex, selectedIndexes));
  }
  return [...selectedIndexes]
    .sort((a, b) => a - b)
    .map((index) => items[index]);
}

function nearestUnusedDistanceIndex(cumulative, targetDistance, usedIndexes) {
  let high = cumulative.findIndex((distance) => distance >= targetDistance);
  if (high < 0) high = cumulative.length - 1;
  const low = Math.max(0, high - 1);
  const targetIndex = Math.abs(cumulative[low] - targetDistance) <= Math.abs(cumulative[high] - targetDistance)
    ? low
    : high;
  return nearestUnusedIndex(cumulative.length, targetIndex, usedIndexes);
}

function nearestUnusedIndex(length, targetIndex, usedIndexes) {
  if (!usedIndexes.has(targetIndex)) return targetIndex;
  for (let offset = 1; offset < length; offset += 1) {
    const left = targetIndex - offset;
    const right = targetIndex + offset;
    if (left >= 0 && !usedIndexes.has(left)) return left;
    if (right < length && !usedIndexes.has(right)) return right;
  }
  return targetIndex;
}

function routeRotation(points) {
  const first = points[0];
  const last = points.at(-1);
  let dx = last.x - first.x;
  let dy = last.y - first.y;
  if (Math.hypot(dx, dy) < 1) {
    let farthest = first;
    let farthestDistance = -Infinity;
    for (const point of points) {
      const distance = Math.hypot(point.x - first.x, point.y - first.y);
      if (distance > farthestDistance) {
        farthestDistance = distance;
        farthest = point;
      }
    }
    dx = farthest.x - first.x;
    dy = farthest.y - first.y;
  }
  const angle = Math.atan2(dy, dx);
  return { cos: Math.cos(angle), sin: Math.sin(angle) };
}

function rotatePoint(point, rotation) {
  return {
    x: rotation.cos * point.x + rotation.sin * point.y,
    y: -rotation.sin * point.x + rotation.cos * point.y,
  };
}

function independentAxisViewport(points, frame) {
  const allX = points.map((point) => point.x);
  const allY = points.map((point) => point.y);
  let minX = Math.min(...allX);
  let maxX = Math.max(...allX);
  let minY = Math.min(...allY);
  let maxY = Math.max(...allY);
  if (maxX - minX < 1) {
    const center = (minX + maxX) / 2;
    minX = center - 0.5;
    maxX = center + 0.5;
  }
  if (maxY - minY < 1) {
    const center = (minY + maxY) / 2;
    minY = center - 0.5;
    maxY = center + 0.5;
  }
  const xPadding = (maxX - minX) * 0.08;
  const yPadding = (maxY - minY) * 0.14;
  minX -= xPadding;
  maxX += xPadding;
  minY -= yPadding;
  maxY += yPadding;
  return {
    map(point) {
      return [
        frame.x + ((point.x - minX) / (maxX - minX)) * frame.width,
        frame.y + frame.height - ((point.y - minY) / (maxY - minY)) * frame.height,
      ];
    },
  };
}

function projectedSpanM(points) {
  const allX = points.map((point) => point.x);
  const allY = points.map((point) => point.y);
  return Math.hypot(
    Math.max(...allX) - Math.min(...allX),
    Math.max(...allY) - Math.min(...allY),
  );
}

function fitViewport(points, frame, paddingRatio, minimumSpanM) {
  const allX = points.map((point) => point.x);
  const allY = points.map((point) => point.y);
  let minX = Math.min(...allX);
  let maxX = Math.max(...allX);
  let minY = Math.min(...allY);
  let maxY = Math.max(...allY);
  if (maxX - minX < minimumSpanM) {
    const center = (minX + maxX) / 2;
    minX = center - minimumSpanM / 2;
    maxX = center + minimumSpanM / 2;
  }
  if (maxY - minY < minimumSpanM) {
    const center = (minY + maxY) / 2;
    minY = center - minimumSpanM / 2;
    maxY = center + minimumSpanM / 2;
  }
  const xPadding = (maxX - minX) * paddingRatio;
  const yPadding = (maxY - minY) * paddingRatio;
  minX -= xPadding;
  maxX += xPadding;
  minY -= yPadding;
  maxY += yPadding;
  const scale = Math.min(frame.width / (maxX - minX), frame.height / (maxY - minY));
  const drawWidth = (maxX - minX) * scale;
  const drawHeight = (maxY - minY) * scale;
  const offsetX = frame.x + (frame.width - drawWidth) / 2;
  const offsetY = frame.y + (frame.height - drawHeight) / 2;
  return {
    map(point) {
      return [
        offsetX + (point.x - minX) * scale,
        offsetY + drawHeight - (point.y - minY) * scale,
      ];
    },
  };
}

function fixedViewport(center, spanX, spanY, frame) {
  const minX = center.x - spanX / 2;
  const minY = center.y - spanY / 2;
  return {
    map(point) {
      return [
        frame.x + ((point.x - minX) / spanX) * frame.width,
        frame.y + frame.height - ((point.y - minY) / spanY) * frame.height,
      ];
    },
  };
}

function insideFrame(x, y, frame) {
  return x >= frame.x && x <= frame.x + frame.width && y >= frame.y && y <= frame.y + frame.height;
}

function gridLines(frame, verticalDivisions, horizontalDivisions, className) {
  const lines = [];
  for (let i = 0; i <= verticalDivisions; i += 1) {
    const x = frame.x + (frame.width * i) / verticalDivisions;
    lines.push(`<line x1="${x}" y1="${frame.y}" x2="${x}" y2="${frame.y + frame.height}" class="${className}"/>`);
  }
  for (let i = 0; i <= horizontalDivisions; i += 1) {
    const y = frame.y + (frame.height * i) / horizontalDivisions;
    lines.push(`<line x1="${frame.x}" y1="${y}" x2="${frame.x + frame.width}" y2="${y}" class="${className}"/>`);
  }
  return lines.join("\n  ");
}

function formatDistance(distanceM) {
  if (!Number.isFinite(distanceM)) return "";
  if (distanceM >= 1000) return `${formatNumber(distanceM / 1000, 2)} km`;
  return `${formatNumber(distanceM, distanceM < 10 ? 2 : 1)} m`;
}

function renderGallery(bestSummaries) {
  const note = sequenceLimitPerTrack > 0
    ? (
      sequenceScope === "mmsi"
        ? `Setiap gambar berisi overview MMSI penuh, detail maksimum ${sequenceLimitPerTrack} observasi kontinu, dan grafik selisih AIS-Kalman dalam meter. Kalman dihitung lebih dahulu pada seluruh urutan MMSI; koordinat tidak dimagnifikasi atau diinterpolasi.`
        : `Setiap gambar berisi overview lintasan kontinu, detail maksimum ${sequenceLimitPerTrack} observasi berurutan, dan grafik selisih AIS-Kalman dalam meter. Kalman dihitung lebih dahulu pada seluruh track part; koordinat tidak dimagnifikasi atau diinterpolasi.`
    )
    : "Merah adalah seluruh input AIS mentah dan biru adalah seluruh hasil Kalman. Semua titik digunakan. Karena lintasan kapal jauh lebih panjang daripada koreksi Kalman, selisih merah-biru dimagnifikasi otomatis pada SVG dan faktor pembesarannya tertulis pada gambar. CSV dan GeoJSON tetap menyimpan koordinat asli tanpa perubahan.";
  const cards = bestSummaries
    .map(
      (row) => `      <article>
        <h2>${escapeHtml(row.gear_label)} — ${escapeHtml(row.vessel_name)} (${escapeHtml(row.mmsi)})</h2>
        <p>${row.point_count} titik, ${(Number(row.total_distance_m) / 1000).toFixed(1)} km, ${escapeHtml(row.start_time)} sampai ${escapeHtml(row.end_time)}</p>
        <img src="${escapeHtml(row.best_svg_path)}" alt="Trajectory ${escapeHtml(row.track_id)}">
      </article>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="id">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Best labeled AIS trajectories</title>
  <style>
    body { margin: 0; padding: 24px; font-family: Arial, sans-serif; background: #eef5fb; color: #102a43; }
    h1 { margin-top: 0; }
    .note { max-width: 1100px; line-height: 1.5; }
    .note + .note { display: none; }
    article { margin: 24px 0; padding: 18px; background: white; border: 1px solid #aac7df; border-radius: 12px; box-shadow: 0 4px 16px #315b7d1a; }
    article h2 { margin: 0 0 6px; }
    article p { margin: 0 0 14px; }
    img { display: block; width: 100%; height: auto; border: 1px solid #d5e4f0; }
  </style>
</head>
<body>
  <h1>Best labeled AIS trajectory examples</h1>
  <p class="note">${escapeHtml(note)}</p>
  <p class="note">Merah adalah seluruh input AIS mentah dan biru adalah seluruh hasil Kalman. Semua titik digunakan. Karena lintasan kapal jauh lebih panjang daripada koreksi Kalman, selisih merah–biru dimagnifikasi otomatis pada SVG dan faktor pembesarannya tertulis pada gambar. CSV dan GeoJSON tetap menyimpan koordinat asli tanpa perubahan.</p>
${cards}
</body>
</html>
`;
}

function lineFeature(track, stats, trajectoryType, coordinates) {
  return {
    type: "Feature",
    properties: {
      trajectory_type: trajectoryType,
      gear_label: track.gearLabel,
      mmsi: track.mmsi,
      vessel_name: track.vesselName,
      seg_id: track.segmentId,
      track_id: track.trackId,
      point_count: track.items.length,
      source_point_count: track.sourcePointCount ?? track.items.length,
      sequence_window_start_source_index: track.selectionStartSourceSequence ?? 1,
      sequence_window_end_source_index: track.selectionEndSourceSequence ?? track.items.length,
      sequence_limit_per_track: sequenceLimitPerTrack || null,
      sequence_selection_strategy: sequenceSelectionStrategy,
      sequence_scope: sequenceScope,
      start_time: track.items[0].time.toISOString(),
      end_time: track.items.at(-1).time.toISOString(),
      total_distance_m: Number(formatNumber(stats.totalDistanceM, 3)),
      displacement_m: Number(formatNumber(stats.displacementM, 3)),
      source: trajectoryType === "ais_input"
        ? "original timestamp/lat/lon from labeled GFW AIS track"
        : "constant-velocity Kalman estimate from the same AIS observations",
    },
    geometry: { type: "LineString", coordinates },
  };
}

function trajectoryFileName(track) {
  const start = track.items[0].time.toISOString().replaceAll(/[-:.]/g, "").replace("Z", "Z");
  return `trajectory_${safeFileName(track.gearLabel)}_${safeFileName(track.mmsi)}_${start}_part${String(track.partIndex).padStart(2, "0")}.svg`;
}

function velocityMeasurement(row) {
  const speedKnots = number(row.speed);
  const courseDeg = number(row.course);
  if (!Number.isFinite(speedKnots) || !Number.isFinite(courseDeg) || speedKnots < 0) return null;
  const speedMps = speedKnots * 0.514444;
  const radians = toRad(normalizeAngle(courseDeg));
  return {
    vx: speedMps * Math.sin(radians),
    vy: speedMps * Math.cos(radians),
  };
}

function predict(state, covariance, dtSeconds) {
  const f = [
    [1, 0, dtSeconds, 0],
    [0, 1, 0, dtSeconds],
    [0, 0, 1, 0],
    [0, 0, 0, 1],
  ];
  return {
    state: matVecMul(f, state),
    covariance: matAdd(
      matMul(matMul(f, covariance), transpose(f)),
      processNoise(dtSeconds, processAccelerationSigma),
    ),
  };
}

function updatePosition(state, covariance, x, y) {
  const h = [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
  ];
  return kalmanUpdate(
    state,
    covariance,
    [x, y],
    h,
    diag([positionMeasurementSigma ** 2, positionMeasurementSigma ** 2]),
  );
}

function updateVelocity(state, covariance, vx, vy) {
  const h = [
    [0, 0, 1, 0],
    [0, 0, 0, 1],
  ];
  return kalmanUpdate(
    state,
    covariance,
    [vx, vy],
    h,
    diag([velocityMeasurementSigma ** 2, velocityMeasurementSigma ** 2]),
  );
}

function kalmanUpdate(state, covariance, measurement, h, r) {
  const ht = transpose(h);
  const innovation = vecSub(measurement, matVecMul(h, state));
  const innovationCovariance = matAdd(matMul(matMul(h, covariance), ht), r);
  const gain = matMul(matMul(covariance, ht), inverse2(innovationCovariance));
  const updatedState = vecAdd(state, matVecMul(gain, innovation));
  const identityMinusKh = matSub(identity(4), matMul(gain, h));
  const updatedCovariance = matAdd(
    matMul(matMul(identityMinusKh, covariance), transpose(identityMinusKh)),
    matMul(matMul(gain, r), transpose(gain)),
  );
  return { state: updatedState, covariance: symmetrize(updatedCovariance) };
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
  const earthM = 6_371_008.8;
  return {
    x: toRad(lon - refLon) * earthM * Math.cos(toRad(refLat)),
    y: toRad(lat - refLat) * earthM,
  };
}

function unprojectFromMeters(x, y, refLat, refLon) {
  const earthM = 6_371_008.8;
  return {
    lat: refLat + toDeg(y / earthM),
    lon: refLon + toDeg(x / (earthM * Math.cos(toRad(refLat)))),
  };
}

function haversineM(lat1, lon1, lat2, lon2) {
  const earthM = 6_371_008.8;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * earthM * Math.asin(Math.min(1, Math.sqrt(a)));
}

function parseCsv(input) {
  const allRows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    const next = input[i + 1];
    if (inQuotes) {
      if (char === '"' && next === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') inQuotes = false;
      else field += char;
    } else if (char === '"') inQuotes = true;
    else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      allRows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") field += char;
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
      .map((cells) => Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ""]))),
  };
}

function stringifyCsv(headers, rows) {
  return [
    headers.map(escapeCsv).join(","),
    ...rows.map((row) => headers.map((header) => escapeCsv(row[header] ?? "")).join(",")),
  ].join("\n") + "\n";
}

function linePath(points) {
  return points
    .map(([x, y], index) => `${index === 0 ? "M" : "L"} ${formatNumber(x, 2)} ${formatNumber(y, 2)}`)
    .join(" ");
}

function groupBy(items, keyFunction) {
  const groups = new Map();
  for (const item of items) {
    const key = keyFunction(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return groups;
}

function firstNonBlank(values) {
  return values.find((item) => value(item)) ?? "";
}

function parseArgs(tokens) {
  const parsed = {};
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = tokens[i + 1];
    if (next && !next.startsWith("--")) {
      parsed[key] = next;
      i += 1;
    } else parsed[key] = true;
  }
  return parsed;
}

function positiveInteger(input, fallback) {
  const parsed = Number.parseInt(input, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function positiveNumber(input, fallback) {
  const parsed = Number(input);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseDate(input) {
  const date = new Date(value(input));
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
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function formatNumber(input, digits) {
  return Number.isFinite(input) ? input.toFixed(digits).replace(/\.?0+$/, "") : "";
}

function normalizeAngle(input) {
  return ((input % 360) + 360) % 360;
}

function safeFileName(input) {
  return value(input).replace(/[^A-Za-z0-9._-]+/g, "_") || "unknown";
}

function normalizePath(input) {
  return input.replaceAll("\\", "/");
}

function escapeCsv(input) {
  const string = String(input ?? "");
  return /[",\r\n]/.test(string) ? `"${string.replaceAll('"', '""')}"` : string;
}

function escapeXml(input) {
  return value(input)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeHtml(input) {
  return escapeXml(input).replaceAll("'", "&#39;");
}

function toRad(degrees) {
  return degrees * Math.PI / 180;
}

function toDeg(radians) {
  return radians * 180 / Math.PI;
}

function identity(size) {
  return Array.from({ length: size }, (_, row) =>
    Array.from({ length: size }, (_, column) => (row === column ? 1 : 0)));
}

function diag(values) {
  return values.map((value, row) => values.map((_, column) => (row === column ? value : 0)));
}

function transpose(matrix) {
  return matrix[0].map((_, column) => matrix.map((row) => row[column]));
}

function matMul(a, b) {
  return a.map((row) =>
    b[0].map((_, column) => row.reduce((sum, value, index) => sum + value * b[index][column], 0)));
}

function matVecMul(matrix, vector) {
  return matrix.map((row) => row.reduce((sum, value, index) => sum + value * vector[index], 0));
}

function matAdd(a, b) {
  return a.map((row, i) => row.map((value, j) => value + b[i][j]));
}

function matSub(a, b) {
  return a.map((row, i) => row.map((value, j) => value - b[i][j]));
}

function vecAdd(a, b) {
  return a.map((value, index) => value + b[index]);
}

function vecSub(a, b) {
  return a.map((value, index) => value - b[index]);
}

function inverse2(matrix) {
  const determinant = matrix[0][0] * matrix[1][1] - matrix[0][1] * matrix[1][0];
  if (Math.abs(determinant) < 1e-12) throw new Error("Kalman innovation matrix is singular.");
  return [
    [matrix[1][1] / determinant, -matrix[0][1] / determinant],
    [-matrix[1][0] / determinant, matrix[0][0] / determinant],
  ];
}

function symmetrize(matrix) {
  return matrix.map((row, i) => row.map((value, j) => (value + matrix[j][i]) / 2));
}
