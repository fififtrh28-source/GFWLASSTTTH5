import { readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);

const inputPath = process.argv[2]
  ? join(process.cwd(), process.argv[2])
  : join(repoRoot, "new", "metadata", "metadata_with_vv_vh_gfw_ais_identity_sog_cog_enriched_ais_position_enriched.csv");

const parsed = parsePath(inputPath);
const outputPath = join(parsed.dir, `${parsed.base}_imo_enriched${parsed.ext}`);
const stillMissingPath = join(parsed.dir, `${parsed.base}_still_missing_imo${parsed.ext}`);
const reportPath = join(parsed.dir, `${parsed.base}_imo_enriched_report.txt`);

const { headers, rows } = parseCsv(readFileSync(inputPath, "utf8"));

const addedColumns = [
  "IMO_original",
  "IMO_enrichment_status",
  "IMO_enrichment_source",
  "IMO_enrichment_source_url",
  "IMO_enrichment_note",
];

const outputHeaders = [...headers];
for (const col of addedColumns) {
  if (!outputHeaders.includes(col)) outputHeaders.push(col);
}

const sourcePriority = [
  { field: "gfw_imo", source: "GFW selfReportedInfo.imo", urlField: "" },
  { field: "gfw_registry_imo", source: "GFW registry IMO", urlField: "" },
  { field: "vesselfinder_imo", source: "VesselFinder details page", urlField: "vesselfinder_source_url" },
  { field: "boat_agent_imo", source: "Boat Agent vessel page", urlField: "boat_agent_source_url" },
  { field: "shipxplorer_imo", source: "ShipXplorer vessel page", urlField: "shipxplorer_source_url" },
];

let alreadyPresent = 0;
let filled = 0;
const filledBySource = new Map();

for (const row of rows) {
  row.IMO_original = value(row.IMO);

  if (validImo(row.IMO)) {
    alreadyPresent += 1;
    row.IMO = normalizeImo(row.IMO);
    row.IMO_enrichment_status = "already_present";
    row.IMO_enrichment_source = value(row.IMO_source) || "existing_IMO_column";
    row.IMO_enrichment_source_url = value(row.IMO_source_url);
    row.IMO_enrichment_note = "";
    continue;
  }

  const candidate = sourcePriority
    .map((source) => ({
      ...source,
      imo: normalizeImo(row[source.field]),
      url: source.urlField ? value(row[source.urlField]) : "",
    }))
    .find((source) => validImo(source.imo));

  if (candidate) {
    row.IMO = candidate.imo;
    row.IMO_source = candidate.source;
    row.IMO_source_url = candidate.url;
    row.IMO_enrichment_status = "filled_from_existing_source_column";
    row.IMO_enrichment_source = candidate.source;
    row.IMO_enrichment_source_url = candidate.url;
    row.IMO_enrichment_note = `Filled from existing dataset column ${candidate.field}; not guessed.`;
    filled += 1;
    filledBySource.set(candidate.source, (filledBySource.get(candidate.source) ?? 0) + 1);
    continue;
  }

  row.IMO_enrichment_status = "still_missing_no_valid_source";
  row.IMO_enrichment_source = "";
  row.IMO_enrichment_source_url = "";
  row.IMO_enrichment_note = "No valid IMO found in existing source columns. Needs manual/authorized external lookup.";
}

const missingRows = rows.filter((row) => !validImo(row.IMO));
writeFileSync(outputPath, stringifyCsv(outputHeaders, rows), "utf8");
writeFileSync(stillMissingPath, stringifyCsv(outputHeaders, missingRows), "utf8");

const report = [
  "IMO enrichment report",
  "",
  `Input: ${relative(repoRoot, inputPath)}`,
  `Output: ${relative(repoRoot, outputPath)}`,
  `Still missing list: ${relative(repoRoot, stillMissingPath)}`,
  "",
  `Rows: ${rows.length}`,
  `IMO already present: ${alreadyPresent}`,
  `IMO filled from existing source columns: ${filled}`,
  `IMO still missing: ${missingRows.length}`,
  "",
  "Filled by source:",
  ...([...filledBySource.entries()].length
    ? [...filledBySource.entries()].map(([source, count]) => `- ${source}: ${count}`)
    : ["- none"]),
  "",
  "Rules:",
  "- Existing IMO values are preserved.",
  "- Missing IMO is filled only from another valid IMO column already present in the dataset.",
  "- Rows without a valid source are left blank; no IMO is guessed from vessel name/MMSI.",
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

function value(input) {
  return String(input ?? "").trim();
}

function normalizeImo(input) {
  const raw = value(input);
  if (!raw) return "";
  const match = raw.match(/\d{7}/);
  return match ? match[0] : "";
}

function validImo(input) {
  return /^\d{7}$/.test(normalizeImo(input));
}
