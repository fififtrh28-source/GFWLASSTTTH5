import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const args = parseArgs(process.argv.slice(2));

const inputDir = resolve(args["input-dir"] ?? join(repoRoot, "Dataset_Test_Enriched"));
const outputDir = resolve(
  args["output-dir"] ??
  join(inputDir, "trajectory_outputs_25seq_per_mmsi_reference_style"),
);
const sourceRenderer = resolve(
  args["source-renderer"] ??
  "D:/FILE FIFI/GFW/GFWAISSAR-ai-test/scripts/build-ais-kalman-patches.mjs",
);
const sequenceLength = 25;
const windowStride = positiveInteger(args["window-stride"], 0);
const multipleWindowsPerMmsi = windowStride > 0;
const stagingDir = `${outputDir}.staging`;

if (!existsSync(inputDir)) throw new Error(`Input directory does not exist: ${inputDir}`);
if (!existsSync(sourceRenderer)) throw new Error(`Reference renderer does not exist: ${sourceRenderer}`);
if (existsSync(outputDir) || existsSync(stagingDir)) {
  throw new Error(
    `Output or staging directory already exists.\nOutput: ${outputDir}\nStaging: ${stagingDir}`,
  );
}

let stagingCreated = false;
try {
  const stagingArgs = [
    "--input-dir", inputDir,
    "--output-dir", stagingDir,
    "--sequence-scope", "mmsi",
    "--best-per-label", "3",
  ];
  if (!multipleWindowsPerMmsi) {
    stagingArgs.push(
      "--sequence-limit-per-track", String(sequenceLength),
      "--sequence-selection", "residual-window",
    );
  }
  runNode(join(repoRoot, "scripts", "create-labeled-ais-trajectories.mjs"), stagingArgs);
  stagingCreated = true;

  const stagingCsv = join(stagingDir, "trajectory_points_raw_vs_kalman.csv");
  const { rows } = parseCsv(readFileSync(stagingCsv, "utf8"));
  const rowsByMmsi = groupBy(rows, (row) => String(row.mmsi ?? "").trim());
  const invalidGroups = [...rowsByMmsi.entries()]
    .filter(([mmsi, group]) =>
      !mmsi ||
      (multipleWindowsPerMmsi ? group.length < sequenceLength : group.length !== sequenceLength))
    .map(([mmsi, group]) => `${mmsi || "(blank)"}=${group.length}`);
  if (invalidGroups.length) {
    throw new Error(
      multipleWindowsPerMmsi
        ? `Every MMSI must contain at least ${sequenceLength} points: ${invalidGroups.join(", ")}`
        : `Every MMSI must contain exactly ${sequenceLength} points: ${invalidGroups.join(", ")}`,
    );
  }

  const orderedRows = [...rowsByMmsi.entries()]
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
    .flatMap(([, group]) =>
      group.toSorted((a, b) => Number(a.sequence_index) - Number(b.sequence_index)));

  const rendererHeaders = [
    "mmsi",
    "timestamp",
    "time_iso",
    "kalman_lat",
    "kalman_lon",
    "raw_lat",
    "raw_lon",
    "kalman_speed_kn",
    "kalman_course_deg",
    "raw_speed_kn",
    "raw_course_deg",
    "kalman_correction_m",
    "kalman_uncertainty_m",
    "kalman_reset",
    "kalman_reset_reason",
    "source",
    "gear",
    "gear_label",
    "dataset_file",
  ];
  const rendererRows = orderedRows.map((row) => {
    const rawLat = finiteNumber(row.lat);
    const rawLon = finiteNumber(row.lon);
    const kalmanLat = finiteNumber(row.kalman_est_lat);
    const kalmanLon = finiteNumber(row.kalman_est_lon);
    const date = new Date(row.timestamp);
    if (
      !Number.isFinite(rawLat) ||
      !Number.isFinite(rawLon) ||
      !Number.isFinite(kalmanLat) ||
      !Number.isFinite(kalmanLon) ||
      Number.isNaN(date.getTime())
    ) {
      throw new Error(`Invalid trajectory row for MMSI ${row.mmsi}, sequence ${row.sequence_index}`);
    }
    const iso = date.toISOString().replace(".000Z", "Z");
    return {
      mmsi: row.mmsi,
      timestamp: Math.round(date.getTime() / 1000),
      time_iso: iso,
      kalman_lat: formatNumber(kalmanLat, 10),
      kalman_lon: formatNumber(kalmanLon, 10),
      raw_lat: formatNumber(rawLat, 10),
      raw_lon: formatNumber(rawLon, 10),
      kalman_speed_kn: row.kalman_est_speed_knots,
      kalman_course_deg: row.kalman_est_course_deg,
      raw_speed_kn: row.speed,
      raw_course_deg: row.course,
      kalman_correction_m: formatNumber(
        haversineM(rawLat, rawLon, kalmanLat, kalmanLon),
        3,
      ),
      kalman_uncertainty_m: row.kalman_position_sigma_m,
      kalman_reset: "0",
      kalman_reset_reason: "",
      source: row.source,
      gear: row.gear_label,
      gear_label: row.gear_label,
      dataset_file: row.input_file,
    };
  });

  mkdirSync(outputDir, { recursive: false });
  const rendererInput = join(outputDir, "ais_kalman_25seq_per_mmsi.csv");
  writeFileSync(rendererInput, stringifyCsv(rendererHeaders, rendererRows), "utf8");
  copyFileSync(stagingCsv, join(outputDir, "trajectory_points_raw_vs_kalman.csv"));
  copyFileSync(
    join(stagingDir, "trajectory_segments_summary.csv"),
    join(outputDir, "trajectory_mmsi_summary.csv"),
  );

  runNode(sourceRenderer, [], {
    AIS_KALMAN_PATCH_RENDER_MODE: "residual",
    AIS_KALMAN_PATCH_INPUT: rendererInput,
    AIS_KALMAN_PATCH_DIR: outputDir,
    AIS_KALMAN_PATCH_SEQ_LEN: String(sequenceLength),
    AIS_KALMAN_PATCH_STRIDE: multipleWindowsPerMmsi ? String(windowStride) : "1000000",
    AIS_KALMAN_PATCH_MIN_POINTS: String(sequenceLength),
    AIS_KALMAN_PATCH_MAX_TOTAL: String(
      multipleWindowsPerMmsi
        ? expectedWindowCount(rowsByMmsi, sequenceLength, windowStride)
        : rowsByMmsi.size,
    ),
    AIS_KALMAN_PATCH_IMAGE_SIZE: "512",
    AIS_KALMAN_PATCH_SPLIT_ON_RESET: "0",
  });

  const jsonlPath = join(outputDir, "ais_kalman_residual_patches.jsonl");
  const records = readFileSync(jsonlPath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const expectedImages = multipleWindowsPerMmsi
    ? expectedWindowCount(rowsByMmsi, sequenceLength, windowStride)
    : rowsByMmsi.size;
  if (records.length !== expectedImages) {
    throw new Error(`Expected ${expectedImages} images, received ${records.length}`);
  }
  const wrongPointCounts = records.filter((record) => record.point_count !== sequenceLength);
  if (wrongPointCounts.length) {
    throw new Error(`Some rendered images do not contain exactly ${sequenceLength} points.`);
  }

  writeFileSync(join(outputDir, "trajectory_gallery.html"), renderGallery(records), "utf8");
  const report = [
    "REFERENCE-STYLE AIS VS KALMAN EXPORT",
    "",
    `MMSI count: ${rowsByMmsi.size}`,
    `Points per MMSI: ${sequenceLength}`,
    `PNG count: ${records.length}`,
    `Window mode: ${multipleWindowsPerMmsi ? `multiple non-overlapping/stepped windows, stride ${windowStride}` : "one selected window per MMSI"}`,
    "PNG dimensions: 2048 x 1024",
    "Visual concept: exact residual diagram renderer from the supplied reference project.",
    "Elements: MMSI/time header, one framed chart, T1-T25 labels, red dashed raw AIS, solid blue Kalman, white AIS markers, gray correction lines, and the original bottom legend.",
    "No overview panel, residual chart, badge, start/end marker, or other visual element is added.",
    "",
    `Source input: ${relative(repoRoot, inputDir).replaceAll("\\", "/")}`,
    `Output: ${relative(repoRoot, outputDir).replaceAll("\\", "/")}`,
  ].join("\n");
  writeFileSync(join(outputDir, "README.txt"), report, "utf8");
  console.log(report);
} finally {
  if (stagingCreated && existsSync(stagingDir)) {
    const resolvedStaging = resolve(stagingDir);
    const resolvedInput = resolve(inputDir);
    const safeName = basename(resolvedStaging).endsWith(".staging");
    const insideInput = resolvedStaging.startsWith(`${resolvedInput}\\`);
    if (!safeName || !insideInput) {
      throw new Error(`Refusing to remove unsafe staging directory: ${resolvedStaging}`);
    }
    rmSync(resolvedStaging, { recursive: true, force: false });
  }
}

function runNode(script, scriptArgs, extraEnv = {}) {
  const result = spawnSync(process.execPath, [script, ...scriptArgs], {
    cwd: repoRoot,
    env: { ...process.env, ...extraEnv },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    const cause = result.error ? `\n${result.error.stack || result.error.message}` : "";
    throw new Error(`Command failed (${result.status}): node ${script}${cause}`);
  }
}

function renderGallery(records) {
  const images = records
    .toSorted(
      (a, b) =>
        String(a.gear).localeCompare(String(b.gear)) ||
        String(a.mmsi).localeCompare(String(b.mmsi), undefined, { numeric: true }),
    )
    .map((record) => {
      const src = `images/${basename(record.patch_image_file)}`;
      return `  <img src="${escapeHtml(src)}" alt="MMSI ${escapeHtml(record.mmsi)}">`;
    })
    .join("\n");
  return `<!doctype html>
<html lang="id">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AIS input vs Kalman - 25 titik per MMSI</title>
  <style>
    html, body { margin: 0; background: #f8fbff; }
    img { display: block; width: 100%; height: auto; margin: 0; }
  </style>
</head>
<body>
${images}
</body>
</html>
`;
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      index += 1;
    }
  }
  return parsed;
}

function parseCsv(text) {
  const records = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\"") {
      if (quoted && text[index + 1] === "\"") {
        cell += "\"";
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(cell);
      cell = "";
      if (row.some((value) => value !== "")) records.push(row);
      row = [];
    } else {
      cell += char;
    }
  }
  if (cell || row.length) {
    row.push(cell);
    records.push(row);
  }
  const headers = records.shift() ?? [];
  return {
    headers,
    rows: records.map((cells) =>
      Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ""]))),
  };
}

function stringifyCsv(headers, rows) {
  return [
    headers.map(csvCell).join(","),
    ...rows.map((row) => headers.map((header) => csvCell(row[header] ?? "")).join(",")),
  ].join("\n") + "\n";
}

function csvCell(input) {
  const text = String(input ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll("\"", "\"\"")}"` : text;
}

function groupBy(items, keyFn) {
  const groups = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return groups;
}

function expectedWindowCount(rowsByMmsi, length, stride) {
  let count = 0;
  for (const rows of rowsByMmsi.values()) {
    count += Math.floor((rows.length - length) / stride) + 1;
  }
  return count;
}

function positiveInteger(input, fallback) {
  const parsed = Number(input);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function finiteNumber(input) {
  const parsed = Number(input);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function haversineM(lat1, lon1, lat2, lon2) {
  const radiusM = 6_371_008.8;
  const phi1 = lat1 * Math.PI / 180;
  const phi2 = lat2 * Math.PI / 180;
  const deltaPhi = (lat2 - lat1) * Math.PI / 180;
  const deltaLambda = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(deltaPhi / 2) ** 2 +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(deltaLambda / 2) ** 2;
  return radiusM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function formatNumber(input, decimals) {
  return Number.isFinite(Number(input)) ? Number(input).toFixed(decimals).replace(/\.?0+$/, "") : "";
}

function escapeHtml(input) {
  return String(input ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;");
}
