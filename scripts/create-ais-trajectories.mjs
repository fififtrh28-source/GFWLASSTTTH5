import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);

const inputPath = process.argv[2]
  ? join(process.cwd(), process.argv[2])
  : join(repoRoot, "new", "metadata", "metadata_with_vh_gfw_ais_identity_sog_cog_enriched_FINAL_kalman_estimated.csv");

const outputDir = dirname(inputPath);
const pointsPath = join(outputDir, "ais_trajectory_points_raw_vs_kalman.csv");
const rawLinesPath = join(outputDir, "ais_trajectories_raw.geojson");
const kalmanLinesPath = join(outputDir, "ais_trajectories_kalman.geojson");
const comparisonLinesPath = join(outputDir, "ais_trajectories_raw_vs_kalman.geojson");
const plotDir = join(outputDir, "trajectory_plots_svg");
const reportPath = join(outputDir, "ais_trajectories_kalman_report.txt");

const { rows } = parseCsv(readFileSync(inputPath, "utf8"));

const pointHeaders = [
  "MMSI",
  "Name",
  "category",
  "scene",
  "timestamp_utc",
  "sequence_index",
  "observation_count",
  "ais_lat",
  "ais_lon",
  "kalman_lat",
  "kalman_lon",
  "sog",
  "cog",
  "kalman_est_sog",
  "kalman_est_cog",
  "trajectory_point_source",
];

const points = [];
for (const row of rows) {
  const mmsi = value(row.MMSI);
  const time = parseDateish(row.kalman_scene_timestamp_utc) ?? sceneTimestamp(row);
  const kalmanLat = number(row.kalman_est_lat);
  const kalmanLon = number(row.kalman_est_lon);
  const aisLat = number(row.AIS_Latitude);
  const aisLon = number(row.AIS_Longitude);

  if (!mmsi || !time || !finiteLatLon(kalmanLat, kalmanLon)) continue;

  points.push({
    MMSI: mmsi,
    Name: value(row.Name),
    category: value(row.category),
    scene: value(row.scene),
    timestamp_utc: time.toISOString(),
    sequence_index: value(row.kalman_sequence_index),
    observation_count: value(row.kalman_mmsi_observation_count),
    ais_lat: Number.isFinite(aisLat) ? formatNumber(aisLat, 8) : "",
    ais_lon: Number.isFinite(aisLon) ? formatNumber(aisLon, 8) : "",
    kalman_lat: formatNumber(kalmanLat, 8),
    kalman_lon: formatNumber(kalmanLon, 8),
    sog: value(row.Sog),
    cog: value(row.Cog),
    kalman_est_sog: value(row.kalman_est_sog),
    kalman_est_cog: value(row.kalman_est_cog),
    trajectory_point_source: "kalman_est_lat_lon_from_AIS_position_updates",
  });
}

points.sort((a, b) => a.MMSI.localeCompare(b.MMSI) || new Date(a.timestamp_utc) - new Date(b.timestamp_utc));

const groups = new Map();
for (const point of points) {
  if (!groups.has(point.MMSI)) groups.set(point.MMSI, []);
  groups.get(point.MMSI).push(point);
}

const rawFeatures = [];
const kalmanFeatures = [];
for (const [mmsi, group] of groups) {
  if (group.length < 2) continue;
  const commonProperties = {
    MMSI: mmsi,
    Name: firstNonBlank(group.map((p) => p.Name)),
    category: firstNonBlank(group.map((p) => p.category)),
    point_count: group.length,
    start_time_utc: group[0].timestamp_utc,
    end_time_utc: group[group.length - 1].timestamp_utc,
  };

  const rawCoordinates = group
    .filter((p) => Number.isFinite(Number(p.ais_lon)) && Number.isFinite(Number(p.ais_lat)))
    .map((p) => [Number(p.ais_lon), Number(p.ais_lat)]);
  if (rawCoordinates.length >= 2) {
    rawFeatures.push({
      type: "Feature",
      properties: {
        ...commonProperties,
        trajectory_type: "raw_ais_before_kalman",
        source: "AIS_Latitude_AIS_Longitude_before_Kalman",
      },
      geometry: {
        type: "LineString",
        coordinates: rawCoordinates,
      },
    });
  }

  kalmanFeatures.push({
    type: "Feature",
    properties: {
      ...commonProperties,
      trajectory_type: "kalman_after_filter",
      source: "kalman_estimated_AIS_trajectory",
    },
    geometry: {
      type: "LineString",
      coordinates: group.map((p) => [Number(p.kalman_lon), Number(p.kalman_lat)]),
    },
  });
}

mkdirSync(plotDir, { recursive: true });
let plotsWritten = 0;
for (const [mmsi, group] of groups) {
  if (group.length < 2) continue;
  const svg = renderTrajectoryComparisonSvg(mmsi, group);
  if (!svg) continue;
  writeFileSync(join(plotDir, `trajectory_${safeFileName(mmsi)}.svg`), svg, "utf8");
  plotsWritten += 1;
}

writeFileSync(pointsPath, stringifyCsv(pointHeaders, points), "utf8");
writeFileSync(rawLinesPath, JSON.stringify({ type: "FeatureCollection", features: rawFeatures }, null, 2), "utf8");
writeFileSync(kalmanLinesPath, JSON.stringify({ type: "FeatureCollection", features: kalmanFeatures }, null, 2), "utf8");
writeFileSync(comparisonLinesPath, JSON.stringify({ type: "FeatureCollection", features: [...rawFeatures, ...kalmanFeatures] }, null, 2), "utf8");

const report = [
  "AIS trajectory export report",
  "",
  `Input: ${relative(repoRoot, inputPath)}`,
  `Raw vs Kalman trajectory points CSV: ${relative(repoRoot, pointsPath)}`,
  `Raw AIS trajectory GeoJSON: ${relative(repoRoot, rawLinesPath)}`,
  `Kalman trajectory GeoJSON: ${relative(repoRoot, kalmanLinesPath)}`,
  `Combined raw-vs-Kalman GeoJSON: ${relative(repoRoot, comparisonLinesPath)}`,
  `Comparison SVG folder: ${relative(repoRoot, plotDir)}`,
  "",
  `Trajectory points: ${points.length}`,
  `Unique MMSI with trajectory points: ${groups.size}`,
  `MMSI with raw AIS LineString >=2 points: ${rawFeatures.length}`,
  `MMSI with Kalman LineString >=2 points: ${kalmanFeatures.length}`,
  `Single-point MMSI: ${groups.size - kalmanFeatures.length}`,
  `Comparison SVG plots written: ${plotsWritten}`,
  "",
  "Notes:",
  "- Raw AIS trajectory uses AIS_Latitude/AIS_Longitude before Kalman.",
  "- Kalman trajectory uses kalman_est_lat/kalman_est_lon after filtering.",
  "- GeoJSON LineString and SVG plots are only created for MMSI with at least two timestamped points.",
  "- Single-point MMSI remain in the points CSV but cannot form a trajectory line.",
].join("\n");

writeFileSync(reportPath, report, "utf8");
console.log(report);

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

function renderTrajectoryComparisonSvg(mmsi, group) {
  const valid = group
    .map((point, index) => ({
      ...point,
      index,
      rawLat: Number(point.ais_lat),
      rawLon: Number(point.ais_lon),
      kalmanLat: Number(point.kalman_lat),
      kalmanLon: Number(point.kalman_lon),
    }))
    .filter((point) => finiteLatLon(point.rawLat, point.rawLon) && finiteLatLon(point.kalmanLat, point.kalmanLon));

  if (valid.length < 2) return null;

  const width = 1600;
  const height = 760;
  const margin = { left: 70, right: 70, top: 85, bottom: 125 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;
  const allLon = valid.flatMap((point) => [point.rawLon, point.kalmanLon]);
  const allLat = valid.flatMap((point) => [point.rawLat, point.kalmanLat]);
  let minLon = Math.min(...allLon);
  let maxLon = Math.max(...allLon);
  let minLat = Math.min(...allLat);
  let maxLat = Math.max(...allLat);
  if (Math.abs(maxLon - minLon) < 1e-9) {
    minLon -= 0.001;
    maxLon += 0.001;
  }
  if (Math.abs(maxLat - minLat) < 1e-9) {
    minLat -= 0.001;
    maxLat += 0.001;
  }
  const lonPad = (maxLon - minLon) * 0.1;
  const latPad = (maxLat - minLat) * 0.1;
  minLon -= lonPad;
  maxLon += lonPad;
  minLat -= latPad;
  maxLat += latPad;

  const x = (lon) => margin.left + ((lon - minLon) / (maxLon - minLon)) * plotW;
  const y = (lat) => margin.top + (1 - ((lat - minLat) / (maxLat - minLat))) * plotH;
  const rawPath = linePath(valid.map((point) => [x(point.rawLon), y(point.rawLat)]));
  const kalmanPath = linePath(valid.map((point) => [x(point.kalmanLon), y(point.kalmanLat)]));
  const title = `MMSI: ${escapeXml(mmsi)} | ${escapeXml(firstNonBlank(valid.map((p) => p.Name)) || "Unnamed")} | ${valid[0].timestamp_utc} - ${valid[valid.length - 1].timestamp_utc}`;

  const grid = [];
  for (let i = 0; i <= 6; i += 1) {
    const gx = margin.left + (plotW * i) / 6;
    grid.push(`<line x1="${gx}" y1="${margin.top}" x2="${gx}" y2="${margin.top + plotH}" class="grid"/>`);
  }
  for (let i = 0; i <= 5; i += 1) {
    const gy = margin.top + (plotH * i) / 5;
    grid.push(`<line x1="${margin.left}" y1="${gy}" x2="${margin.left + plotW}" y2="${gy}" class="grid"/>`);
  }

  const corrections = valid.map((point) => {
    const x1 = x(point.rawLon);
    const y1 = y(point.rawLat);
    const x2 = x(point.kalmanLon);
    const y2 = y(point.kalmanLat);
    return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" class="correction"/>`;
  }).join("\n");

  const rawMarkers = valid.map((point, i) => {
    const cx = x(point.rawLon);
    const cy = y(point.rawLat);
    return `<circle cx="${cx}" cy="${cy}" r="6" class="raw-point"/><text x="${cx + 10}" y="${cy - 10}" class="label">T${i + 1}</text>`;
  }).join("\n");

  const kalmanMarkers = valid.map((point) => {
    const cx = x(point.kalmanLon);
    const cy = y(point.kalmanLat);
    return `<circle cx="${cx}" cy="${cy}" r="5" class="kalman-point"/>`;
  }).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <style>
    .bg { fill: #f4f9ff; }
    .border { fill: none; stroke: #0b4aaa; stroke-width: 4; }
    .grid { stroke: #9dccff; stroke-width: 2; stroke-dasharray: 6 8; }
    .title { fill: #002b6f; font: 20px monospace; }
    .raw-line { fill: none; stroke: #ff2020; stroke-width: 7; stroke-linecap: round; stroke-linejoin: round; stroke-dasharray: 10 10; }
    .kalman-line { fill: none; stroke: #0066e8; stroke-width: 8; stroke-linecap: round; stroke-linejoin: round; }
    .correction { stroke: #6d6d6d; stroke-width: 3; stroke-dasharray: 5 7; opacity: 0.8; }
    .raw-point { fill: #fff; stroke: #111; stroke-width: 1.5; }
    .kalman-point { fill: #0087ff; stroke: #003d99; stroke-width: 1.5; }
    .label { fill: #002b6f; font: 17px monospace; }
    .legend-text { fill: #1d1d1d; font: 18px monospace; }
  </style>
  <rect class="bg" x="0" y="0" width="${width}" height="${height}"/>
  <text class="title" x="${margin.left}" y="42">${title}</text>
  <rect class="border" x="${margin.left}" y="${margin.top}" width="${plotW}" height="${plotH}"/>
  ${grid.join("\n  ")}
  ${corrections}
  <path d="${rawPath}" class="raw-line"/>
  <path d="${kalmanPath}" class="kalman-line"/>
  ${rawMarkers}
  ${kalmanMarkers}
  <rect class="border" x="${margin.left}" y="${height - 80}" width="${plotW}" height="52"/>
  <line x1="${margin.left + 45}" y1="${height - 54}" x2="${margin.left + 115}" y2="${height - 54}" class="raw-line"/>
  <text x="${margin.left + 135}" y="${height - 48}" class="legend-text">TRAJECTORY AIS MENTAH</text>
  <line x1="${margin.left + 380}" y1="${height - 54}" x2="${margin.left + 455}" y2="${height - 54}" class="kalman-line"/>
  <text x="${margin.left + 475}" y="${height - 48}" class="legend-text">TRAJECTORY HASIL KALMAN</text>
  <circle cx="${margin.left + 770}" cy="${height - 54}" r="7" class="raw-point"/>
  <text x="${margin.left + 790}" y="${height - 48}" class="legend-text">TITIK OBSERVASI AIS</text>
  <line x1="${margin.left + 1085}" y1="${height - 54}" x2="${margin.left + 1160}" y2="${height - 54}" class="correction"/>
  <text x="${margin.left + 1180}" y="${height - 48}" class="legend-text">KOREKSI / PENYESUAIAN KALMAN</text>
</svg>
`;
}

function linePath(points) {
  return points.map(([x, y], index) => `${index === 0 ? "M" : "L"} ${formatNumber(x, 3)} ${formatNumber(y, 3)}`).join(" ");
}

function escapeCsv(input) {
  const s = String(input ?? "");
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
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

function formatNumber(input, digits) {
  return Number.isFinite(input) ? input.toFixed(digits).replace(/\.?0+$/, "") : "";
}

function firstNonBlank(values) {
  return values.find((v) => value(v)) ?? "";
}

function safeFileName(input) {
  return value(input).replace(/[^A-Za-z0-9._-]+/g, "_") || "unknown";
}

function escapeXml(input) {
  return value(input)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
