import { readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);

const inputPath = process.argv[2]
  ? join(process.cwd(), process.argv[2])
  : join(repoRoot, "new", "metadata", "metadata_with_vv_vh_gfw_ais_identity_sog_cog_enriched_ais_position_enriched_completed.csv");

const parsed = parsePath(inputPath);
const outputPath = join(parsed.dir, `${parsed.base}_kalman_ready${parsed.ext}`);
const reportPath = join(parsed.dir, `${parsed.base}_kalman_ready_report.txt`);

const { headers, rows } = parseCsv(readFileSync(inputPath, "utf8"));

const addedColumns = [
  "Sog_for_kalman",
  "Cog_for_kalman",
  "kalman_velocity_status",
  "Sog_for_kalman_source",
  "Cog_for_kalman_source",
  "kalman_velocity_note",
];

const outputHeaders = [...headers];
for (const col of addedColumns) {
  if (!outputHeaders.includes(col)) outputHeaders.push(col);
}

const sogMedianByCategory = groupedMedian(rows, "category", "Sog");
const cogMeanByCategory = groupedCircularMean(rows, "category", "Cog");
const overallSogMedian = median(rows.map((row) => number(row.Sog)).filter(Number.isFinite));
const overallCogMean = circularMean(rows.map((row) => number(row.Cog)).filter(Number.isFinite));

let rawComplete = 0;
let rawSogUsed = 0;
let rawCogUsed = 0;
let sogCategoryMedianImputed = 0;
let sogOverallMedianImputed = 0;
let cogGfwSarBearingUsed = 0;
let cogCategoryMeanImputed = 0;
let cogOverallMeanImputed = 0;

for (const row of rows) {
  const rawSog = number(row.Sog);
  const rawCog = number(row.Cog);
  const category = text(row.category) || "UNKNOWN";

  if (Number.isFinite(rawSog)) {
    row.Sog_for_kalman = formatNumber(rawSog, 6);
    row.Sog_for_kalman_source = "raw_or_enriched_Sog";
    rawSogUsed += 1;
  } else {
    const categoryMedian = sogMedianByCategory.get(category);
    if (Number.isFinite(categoryMedian)) {
      row.Sog_for_kalman = formatNumber(categoryMedian, 6);
      row.Sog_for_kalman_source = `category_median_sog:${category}`;
      sogCategoryMedianImputed += 1;
    } else {
      row.Sog_for_kalman = formatNumber(overallSogMedian, 6);
      row.Sog_for_kalman_source = "overall_median_sog";
      sogOverallMedianImputed += 1;
    }
  }

  if (Number.isFinite(rawCog)) {
    row.Cog_for_kalman = formatAngle(rawCog);
    row.Cog_for_kalman_source = "raw_or_enriched_Cog";
    rawCogUsed += 1;
  } else {
    const gfwSarBearing = number(row.gfw_sar_bearing);
    if (Number.isFinite(gfwSarBearing)) {
      row.Cog_for_kalman = formatAngle(gfwSarBearing);
      row.Cog_for_kalman_source = "gfw_sar_bearing";
      cogGfwSarBearingUsed += 1;
    } else {
      const categoryMean = cogMeanByCategory.get(category);
      if (Number.isFinite(categoryMean)) {
        row.Cog_for_kalman = formatAngle(categoryMean);
        row.Cog_for_kalman_source = `category_circular_mean_cog:${category}`;
        cogCategoryMeanImputed += 1;
      } else {
        row.Cog_for_kalman = formatAngle(overallCogMean);
        row.Cog_for_kalman_source = "overall_circular_mean_cog";
        cogOverallMeanImputed += 1;
      }
    }
  }

  if (Number.isFinite(rawSog) && Number.isFinite(rawCog)) {
    rawComplete += 1;
    row.kalman_velocity_status = "raw_complete";
    row.kalman_velocity_note = "SOG and COG came from existing/enriched dataset columns.";
  } else {
    const missing = [
      Number.isFinite(rawSog) ? "" : "SOG",
      Number.isFinite(rawCog) ? "" : "COG",
    ].filter(Boolean).join("+");
    row.kalman_velocity_status = `kalman_imputed_${missing.toLowerCase()}`;
    row.kalman_velocity_note = "For Kalman only: raw AIS SOG/COG was not available, so a clearly marked modeling value was used. Do not cite this as observed AIS.";
  }
}

writeFileSync(outputPath, stringifyCsv(outputHeaders, rows), "utf8");

const report = [
  "Kalman-ready SOG/COG report",
  "",
  `Input: ${relative(repoRoot, inputPath)}`,
  `Output: ${relative(repoRoot, outputPath)}`,
  "",
  `Rows: ${rows.length}`,
  `Raw complete SOG+COG rows: ${rawComplete}`,
  `Sog_for_kalman filled rows: ${rows.filter((row) => !isBlank(row.Sog_for_kalman)).length}`,
  `Cog_for_kalman filled rows: ${rows.filter((row) => !isBlank(row.Cog_for_kalman)).length}`,
  `Raw/enriched SOG reused: ${rawSogUsed}`,
  `Raw/enriched COG reused: ${rawCogUsed}`,
  `SOG imputed from category median: ${sogCategoryMedianImputed}`,
  `SOG imputed from overall median: ${sogOverallMedianImputed}`,
  `COG filled from GFW SAR bearing: ${cogGfwSarBearingUsed}`,
  `COG imputed from category circular mean: ${cogCategoryMeanImputed}`,
  `COG imputed from overall circular mean: ${cogOverallMeanImputed}`,
  "",
  "Category SOG medians used:",
  ...[...sogMedianByCategory.entries()].map(([category, value]) => `- ${category}: ${formatNumber(value, 6)} knots`),
  "",
  "Rules:",
  "- Raw Sog/Cog columns are not overwritten.",
  "- Sog_for_kalman and Cog_for_kalman are always filled for model input.",
  "- Missing SOG is filled from the median SOG of the same category in this dataset.",
  "- Missing COG is filled from gfw_sar_bearing when available; otherwise from circular mean COG by category.",
  "- Imputed values are modeling values, not observed AIS broadcasts.",
].join("\n");

writeFileSync(reportPath, report, "utf8");
console.log(report);

function groupedMedian(rows, groupKey, valueKey) {
  const groups = new Map();
  for (const row of rows) {
    const group = text(row[groupKey]) || "UNKNOWN";
    const n = number(row[valueKey]);
    if (!Number.isFinite(n)) continue;
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(n);
  }
  return new Map([...groups.entries()].map(([group, values]) => [group, median(values)]));
}

function groupedCircularMean(rows, groupKey, valueKey) {
  const groups = new Map();
  for (const row of rows) {
    const group = text(row[groupKey]) || "UNKNOWN";
    const n = number(row[valueKey]);
    if (!Number.isFinite(n)) continue;
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(n);
  }
  return new Map([...groups.entries()].map(([group, values]) => [group, circularMean(values)]));
}

function median(values) {
  const sorted = values.filter(Number.isFinite).toSorted((a, b) => a - b);
  if (!sorted.length) return NaN;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function circularMean(degrees) {
  const values = degrees.filter(Number.isFinite);
  if (!values.length) return NaN;
  const sum = values.reduce((acc, deg) => {
    const rad = deg * Math.PI / 180;
    acc.sin += Math.sin(rad);
    acc.cos += Math.cos(rad);
    return acc;
  }, { sin: 0, cos: 0 });
  return (Math.atan2(sum.sin / values.length, sum.cos / values.length) * 180 / Math.PI + 360) % 360;
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

function number(value) {
  const raw = text(value);
  if (!raw) return NaN;
  const n = Number(raw);
  return Number.isFinite(n) ? n : NaN;
}

function text(value) {
  return String(value ?? "").trim();
}

function isBlank(value) {
  return text(value) === "";
}

function formatNumber(value, digits) {
  return Number.isFinite(value) ? value.toFixed(digits).replace(/\.?0+$/, "") : "";
}

function formatAngle(value) {
  if (!Number.isFinite(value)) return "";
  return formatNumber(((value % 360) + 360) % 360, 6);
}
