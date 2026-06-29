#!/usr/bin/env node
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const INPUT_FILE = path.join(process.cwd(), "KAPAL YG TERDETEKSI", "final_h5_alert_predictions.csv");
const LOG_FILE = path.join(process.cwd(), "KAPAL YG TERDETEKSI", "telegram_alert_send_log.csv");
const MAX_LIMIT = 10;
const DEFAULT_DELAY_MS = 900;

const FALLBACK_ENRICHMENT_FILES = [
  path.join(process.cwd(), "KAPAL YG TERDETEKSI", "scene_candidates_godark_spoofing_transshipment.csv"),
  path.join(process.cwd(), "KAPAL YG TERDETEKSI", "godark_h5_predictions_fishing_by_scene_enriched_ais.csv"),
  path.join(process.cwd(), "new", "metadata", "metadata_with_vh_gfw_ais_identity_sog_cog_enriched_FINAL_kalman_estimated.csv"),
  path.join(process.cwd(), "new", "metadata", "metadata_with_vv_vh_gfw_ais_identity_sog_cog_enriched_ais_position_enriched_ais_latlon_formula_filled_kalman_estimated.csv"),
  path.join(process.cwd(), "Dataset_Test_Enriched", "drifting_longlines.csv"),
  path.join(process.cwd(), "Dataset_Test_Enriched", "purse_seines.csv"),
  path.join(process.cwd(), "Dataset_Test_Enriched", "fixed_gear.csv"),
  path.join(process.cwd(), "Dataset_Test_Enriched", "trawlers.csv"),
  path.join(process.cwd(), "Dataset_Test_Enriched", "Dataset_Test_Enriched_EEZ_Indonesia", "drifting_longlines.csv"),
  path.join(process.cwd(), "Dataset_Test_Enriched", "Dataset_Test_Enriched_EEZ_Indonesia", "purse_seines.csv"),
  path.join(process.cwd(), "Dataset_Test_Enriched", "Dataset_Test_Enriched_EEZ_Indonesia", "fixed_gear.csv"),
  path.join(process.cwd(), "Dataset_Test_Enriched", "Dataset_Test_Enriched_EEZ_Indonesia", "trawlers.csv"),
];

const MMSI_COLUMNS = ["MMSI", "mmsi", "gfw_ssvid", "ssvid", "vesselfinder_mmsi"];
const SCENE_COLUMNS = ["scene_id", "scene"];
const TIME_COLUMNS = [
  "scene_time_utc",
  "kalman_scene_timestamp_utc",
  "sog_cog_scene_timestamp_utc",
  "ais_position_scene_timestamp_utc",
  "AIS_update_datetime",
  "last_timestamp_utc",
  "timestamp",
  "time",
];
const GEAR_COLUMNS = [
  "gear",
  "gear_type",
  "gear_label",
  "predicted_gear",
  "gear_prediction",
  "gfw_gear",
  "vessel_gear",
  "alat_tangkap",
  "gear_raw_gfw",
  "gear_inferred",
  "gear_registry",
  "ais_gear_label",
  "gfw_geartype",
];
const VESSEL_TYPE_COLUMNS = [
  "vessel_type",
  "gfw_shiptype",
  "Ship_Type",
  "category",
  "Elaborated_type",
];
const VALID_GEAR_LABELS = new Map([
  ["drifting_longlines", "drifting_longlines"],
  ["drifting_longline", "drifting_longlines"],
  ["drifting_long_lines", "drifting_longlines"],
  ["purse_seines", "purse_seines"],
  ["purse_seine", "purse_seines"],
  ["fixed_gear", "fixed_gear"],
  ["fixed_gears", "fixed_gear"],
  ["trawlers", "trawlers"],
  ["trawler", "trawlers"],
]);
const LAT_COLUMNS = [
  "Center_latitude",
  "sar_lat",
  "SAR_Latitude",
  "kalman_est_lat",
  "AIS_Latitude",
  "ais_lat",
  "latitude",
  "lat",
  "Projected_Latitude",
];
const LON_COLUMNS = [
  "Center_longitude",
  "sar_lon",
  "SAR_Longitude",
  "kalman_est_lon",
  "AIS_Longitude",
  "ais_lon",
  "longitude",
  "lon",
  "Projected_Longitude",
];

function loadDotEnv() {
  for (const fileName of [".env", ".env.lokal", ".env.local"]) {
    const envPath = path.join(process.cwd(), fileName);
    if (!fs.existsSync(envPath)) continue;
    for (const line of fs.readFileSync(envPath, "utf-8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 1) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, "");
      if (key) process.env[key] = value;
    }
  }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2).replace(/-/g, "_");
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) out[key] = "true";
    else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
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
  return rows.filter((cells) => cells.some((cell) => String(cell).trim() !== ""));
}

function csvToObjects(text) {
  const records = parseCsv(text);
  if (records.length < 2) return [];
  const header = records[0].map((name) => String(name || "").trim());
  return records.slice(1).map((record) => {
    const row = {};
    header.forEach((name, index) => {
      row[name] = record[index] ?? "";
    });
    return row;
  });
}

function normalizeLabel(value) {
  const raw = String(value || "").toLowerCase().replace(/[\s-]+/g, "_").trim();
  if (raw === "godark" || raw === "go_dark") return "go_dark";
  return raw;
}

function normalizeId(value) {
  const text = String(value ?? "").trim();
  return text.replace(/\.0$/, "");
}

function normalizeScene(value) {
  return String(value ?? "").trim().toLowerCase();
}

function normalizeTimestamp(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  const date = new Date(text);
  if (!Number.isNaN(date.getTime())) return date.toISOString();
  return text.toLowerCase();
}

function firstText(row, names, fallback = "-") {
  for (const name of names) {
    const value = row[name];
    if (value !== undefined && value !== null && String(value).trim() !== "") return String(value).trim();
  }
  return fallback;
}

function numberFrom(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(String(value).replace("%", "").trim());
  return Number.isFinite(n) ? n : null;
}

function scoreFor(row) {
  return (
    numberFrom(row.score) ??
    numberFrom(row.confidence) ??
    numberFrom(row.go_dark_probability) ??
    numberFrom(row.probability) ??
    -1
  );
}

function percentText(value) {
  const n = numberFrom(value);
  if (n === null) return "-";
  const pct = Math.abs(n) <= 1 ? n * 100 : n;
  return `${pct.toFixed(1)}%`;
}

function firstNumber(row, names) {
  for (const name of names) {
    const n = numberFrom(row[name]);
    if (n !== null) return n;
  }
  return null;
}

function coordinateText(row) {
  const lat = row._alert_lat ?? firstNumber(row, LAT_COLUMNS);
  const lon = row._alert_lon ?? firstNumber(row, LON_COLUMNS);
  if (lat === null || lon === null) return { text: "-", mapUrl: "" };
  return {
    text: `${lat.toFixed(5)}, ${lon.toFixed(5)}`,
    mapUrl: `https://www.google.com/maps?q=${lat.toFixed(6)},${lon.toFixed(6)}`,
  };
}

function formatTime(value) {
  const text = String(value || "").trim();
  if (!text) return "-";
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return text;
  return date.toLocaleString("id-ID", { timeZone: "Asia/Bangkok" });
}

function formatGoDarkMessage(row) {
  const score = firstText(row, ["score", "confidence", "go_dark_probability", "probability"], "");
  const gear = row._alert_gear || gearFromRow(row) || "-";
  const vesselType = row._alert_vessel_type || vesselTypeFromRow(row) || "-";
  const coords = coordinateText(row);
  const mapLine = coords.mapUrl ? `Buka lokasi di peta: ${coords.mapUrl}` : "Buka lokasi di peta";

  return [
    "[HIGH] GO DARK INFERENCE ALERT",
    `MMSI: ${firstText(row, ["MMSI", "mmsi"])}`,
    `Gear: ${gear}`,
    `Jenis kapal: ${vesselType}`,
    `Prediksi: go_dark (${percentText(score)})`,
    `Koordinat: ${coords.text}`,
    "Sumber: H5 AI inference batch",
    `Waktu: ${formatTime(row._alert_time || firstText(row, TIME_COLUMNS, ""))}`,
    "Indikasi: pola trajectory AIS menyerupai aktivitas go dark.",
    "",
    mapLine,
  ].join("\n");
}

function resolveDataPath(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  return path.resolve(process.cwd(), text.replace(/\\/g, path.sep));
}

function uniqueExistingPaths(paths) {
  const seen = new Set();
  const out = [];
  for (const item of paths) {
    const resolved = resolveDataPath(item);
    if (!resolved || seen.has(resolved) || !fs.existsSync(resolved)) continue;
    seen.add(resolved);
    out.push(resolved);
  }
  return out;
}

function discoverEnrichmentFiles(rows) {
  const fromH5 = rows
    .map((row) => row.source_scene_file)
    .filter((value) => String(value || "").trim() !== "");
  return uniqueExistingPaths([...fromH5, ...FALLBACK_ENRICHMENT_FILES]);
}

function valueFrom(row, columns) {
  for (const name of columns) {
    const value = row?.[name];
    if (value !== undefined && value !== null && String(value).trim() !== "") return String(value).trim();
  }
  return "";
}

function normalizeGearValue(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const parts = raw
    .split(/[|,;/]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  const candidates = parts.length ? parts : [raw];

  for (const candidate of candidates) {
    const normalized = candidate
      .toLowerCase()
      .replace(/&/g, " and ")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .replace(/_+/g, "_");
    const valid = VALID_GEAR_LABELS.get(normalized);
    if (valid) return valid;
  }

  const joined = raw
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
  for (const [candidate, valid] of VALID_GEAR_LABELS.entries()) {
    if (joined.includes(candidate)) return valid;
  }
  return "";
}

function gearFromRow(row) {
  const values = GEAR_COLUMNS
    .map((name) => row?.[name])
    .filter((value) => value !== undefined && value !== null && String(value).trim() !== "");
  for (const value of values) {
    const gear = normalizeGearValue(value);
    if (gear) return gear;
  }
  return "";
}

function vesselTypeFromRow(row) {
  return valueFrom(row, VESSEL_TYPE_COLUMNS);
}

function mmsiOf(row) {
  return normalizeId(valueFrom(row, MMSI_COLUMNS));
}

function sceneOf(row) {
  return normalizeScene(valueFrom(row, SCENE_COLUMNS));
}

function timestampOf(row) {
  return normalizeTimestamp(valueFrom(row, TIME_COLUMNS));
}

function timestampMs(row) {
  const text = valueFrom(row, TIME_COLUMNS);
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date.getTime();
}

function firstUsefulGear(row) {
  return gearFromRow(row);
}

function firstUsefulVesselType(row) {
  return vesselTypeFromRow(row);
}

function coordinatePair(row) {
  const lat = firstNumber(row, LAT_COLUMNS);
  const lon = firstNumber(row, LON_COLUMNS);
  if (lat === null || lon === null) return null;
  return { lat, lon };
}

function addToMap(map, key, row) {
  if (!key) return;
  const existing = map.get(key);
  if (existing) existing.push(row);
  else map.set(key, [row]);
}

function sourceKey(filePath) {
  return path.resolve(filePath);
}

function hasUsefulEnrichment(row) {
  return Boolean(firstUsefulGear(row) || firstUsefulVesselType(row) || coordinatePair(row));
}

function chooseBestMatch(candidates, targetRow) {
  if (!candidates?.length) return null;
  const useful = candidates.filter(hasUsefulEnrichment);
  const pool = useful.length ? useful : candidates;
  const targetTime = timestampMs(targetRow);
  if (targetTime !== null) {
    return pool
      .map((row) => {
        const t = timestampMs(row);
        return {
          row,
          delta: t === null ? Number.POSITIVE_INFINITY : Math.abs(t - targetTime),
        };
      })
      .sort((a, b) => a.delta - b.delta)[0]?.row || pool[0];
  }
  return pool[0];
}

function buildEnrichmentIndex(files) {
  const index = {
    byFileMmsiTime: new Map(),
    byMmsiTime: new Map(),
    byFileMmsiScene: new Map(),
    byMmsiScene: new Map(),
    byFileMmsi: new Map(),
    byMmsi: new Map(),
    byFileRowIndex: new Map(),
    loadedFiles: [],
  };

  for (const file of files) {
    const rows = csvToObjects(fs.readFileSync(file, "utf-8"));
    const fileKey = sourceKey(file);
    index.loadedFiles.push({ file, rows: rows.length });

    rows.forEach((row, rowIndex) => {
      const enrichedRow = { ...row, _source_file_key: fileKey, _source_row_index: rowIndex };
      const mmsi = mmsiOf(enrichedRow);
      const scene = sceneOf(enrichedRow);
      const ts = timestampOf(enrichedRow);

      addToMap(index.byFileRowIndex, `${fileKey}|${rowIndex}`, enrichedRow);
      if (!mmsi) return;

      addToMap(index.byFileMmsi, `${fileKey}|${mmsi}`, enrichedRow);
      addToMap(index.byMmsi, mmsi, enrichedRow);
      if (ts) {
        addToMap(index.byFileMmsiTime, `${fileKey}|${mmsi}|${ts}`, enrichedRow);
        addToMap(index.byMmsiTime, `${mmsi}|${ts}`, enrichedRow);
      }
      if (scene) {
        addToMap(index.byFileMmsiScene, `${fileKey}|${mmsi}|${scene}`, enrichedRow);
        addToMap(index.byMmsiScene, `${mmsi}|${scene}`, enrichedRow);
      }
    });
  }

  return index;
}

function findEnrichment(row, index) {
  const mmsi = mmsiOf(row);
  const scene = sceneOf(row);
  const ts = timestampOf(row);
  const sourceFile = resolveDataPath(row.source_scene_file);
  const fileKey = sourceFile && fs.existsSync(sourceFile) ? sourceKey(sourceFile) : "";

  if (mmsi && ts && fileKey) {
    const match = chooseBestMatch(index.byFileMmsiTime.get(`${fileKey}|${mmsi}|${ts}`), row);
    if (match) return { row: match, method: "MMSI+timestamp+source_file" };
  }
  if (mmsi && ts) {
    const match = chooseBestMatch(index.byMmsiTime.get(`${mmsi}|${ts}`), row);
    if (match) return { row: match, method: "MMSI+timestamp" };
  }
  if (mmsi && scene && fileKey) {
    const match = chooseBestMatch(index.byFileMmsiScene.get(`${fileKey}|${mmsi}|${scene}`), row);
    if (match) return { row: match, method: "MMSI+scene+source_file" };
  }
  if (mmsi && scene) {
    const match = chooseBestMatch(index.byMmsiScene.get(`${mmsi}|${scene}`), row);
    if (match) return { row: match, method: "MMSI+scene" };
  }
  if (mmsi && fileKey) {
    const match = chooseBestMatch(index.byFileMmsi.get(`${fileKey}|${mmsi}`), row);
    if (match) return { row: match, method: "MMSI+source_file" };
  }
  if (mmsi) {
    const match = chooseBestMatch(index.byMmsi.get(mmsi), row);
    if (match) return { row: match, method: "MMSI" };
  }
  if (fileKey && row._h5_row_index !== undefined) {
    const match = chooseBestMatch(index.byFileRowIndex.get(`${fileKey}|${row._h5_row_index}`), row);
    if (match) return { row: match, method: "row_index+source_file" };
  }
  return null;
}

function enrichRows(rows) {
  const files = discoverEnrichmentFiles(rows);
  const index = buildEnrichmentIndex(files);
  const enrichedRows = rows.map((row, rowIndex) => {
    const base = { ...row, _h5_row_index: rowIndex };
    const match = findEnrichment(base, index);
    const source = match?.row || {};
    const gear = firstUsefulGear(base) || firstUsefulGear(source);
    const vesselType = firstUsefulVesselType(base) || firstUsefulVesselType(source);
    const coords = coordinatePair(base) || coordinatePair(source);
    const time = valueFrom(base, TIME_COLUMNS) || valueFrom(source, TIME_COLUMNS);

    return {
      ...base,
      _alert_gear: gear || "",
      _alert_vessel_type: vesselType || "",
      _alert_lat: coords?.lat ?? null,
      _alert_lon: coords?.lon ?? null,
      _alert_time: time || "",
      _enrichment_method: match?.method || "not_found",
    };
  });

  return { rows: enrichedRows, loadedFiles: index.loadedFiles };
}

function csvEscape(value) {
  const text = String(value ?? "");
  if (!/[",\n\r]/.test(text)) return text;
  return `"${text.replaceAll('"', '""')}"`;
}

async function appendLog({ status, mmsi, candidateType = "go_dark", httpStatus = "", error = "" }) {
  const header = "sent_at_utc,status,mmsi,candidate_type,http_status,error\n";
  const row = [
    new Date().toISOString(),
    status,
    mmsi,
    candidateType,
    httpStatus,
    error,
  ].map(csvEscape).join(",") + "\n";

  await fsp.mkdir(path.dirname(LOG_FILE), { recursive: true });
  if (!fs.existsSync(LOG_FILE)) await fsp.writeFile(LOG_FILE, header, "utf-8");
  await fsp.appendFile(LOG_FILE, row, "utf-8");
}

async function sendTelegram(text, botToken, chatId) {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: false,
    }),
    signal: AbortSignal.timeout(15000),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || data?.ok === false) {
    const detail = data?.description || `Telegram HTTP ${response.status}`;
    const err = new Error(detail);
    err.httpStatus = response.status;
    throw err;
  }
  return {
    httpStatus: response.status,
    messageId: data?.result?.message_id ?? null,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  loadDotEnv();
  const args = parseArgs(process.argv.slice(2));
  const requestedLimit = Number.parseInt(args.limit || String(MAX_LIMIT), 10);
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number.isFinite(requestedLimit) ? requestedLimit : MAX_LIMIT));
  const delayMs = Math.max(800, Number.parseInt(args.delay_ms || String(DEFAULT_DELAY_MS), 10) || DEFAULT_DELAY_MS);
  const dryRun = args.dry_run === "true";
  const requireGear = args.require_gear === "true";

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!dryRun && (!botToken || !chatId)) {
    throw new Error("TELEGRAM_BOT_TOKEN atau TELEGRAM_CHAT_ID belum diisi di .env.local.");
  }

  if (!fs.existsSync(INPUT_FILE)) {
    throw new Error(`File input tidak ditemukan: ${INPUT_FILE}`);
  }

  const h5Rows = csvToObjects(fs.readFileSync(INPUT_FILE, "utf-8"));
  const enriched = enrichRows(h5Rows);
  const goDarkRows = enriched.rows
    .filter((row) => normalizeLabel(row.pred_label) === "go_dark" || normalizeLabel(row.alert_type) === "go_dark")
    .sort((a, b) => scoreFor(b) - scoreFor(a));

  if (!goDarkRows.length) {
    throw new Error("Tidak ada kandidat go_dark pada final_h5_alert_predictions.csv.");
  }

  const gearCount = goDarkRows.filter((row) => row._alert_gear).length;
  const vesselTypeCount = goDarkRows.filter((row) => row._alert_vessel_type).length;
  const coordCount = goDarkRows.filter((row) => row._alert_lat !== null && row._alert_lon !== null).length;
  const stillEmptyCount = goDarkRows.filter((row) => !row._alert_gear || row._alert_lat === null || row._alert_lon === null).length;
  const candidatePool = requireGear ? goDarkRows.filter((row) => row._alert_gear) : goDarkRows;
  if (requireGear && !candidatePool.length) {
    throw new Error("Tidak ada kandidat go_dark dengan gear valid. Jalankan tanpa --require-gear untuk mengirim kandidat tanpa gear.");
  }
  const selected = candidatePool.slice(0, limit);

  console.log(`Kandidat H5 terbaca: ${h5Rows.length}`);
  console.log(`Kandidat go_dark H5: ${goDarkRows.length}`);
  console.log(`Sumber enrichment terbaca: ${enriched.loadedFiles.map((item) => `${path.relative(process.cwd(), item.file)} (${item.rows} baris)`).join("; ") || "-"}`);
  console.log(`Kandidat go_dark berhasil dilengkapi gear: ${gearCount}`);
  console.log(`Kandidat go_dark berhasil dilengkapi jenis kapal: ${vesselTypeCount}`);
  console.log(`Kandidat go_dark berhasil dilengkapi koordinat: ${coordCount}`);
  console.log(`Kandidat go_dark masih kosong gear/koordinat: ${stillEmptyCount}`);
  console.log(`Mode require gear: ${requireGear ? "aktif" : "nonaktif"}`);
  console.log(`Kandidat sumber pengiriman: ${candidatePool.length}`);
  console.log(`Mengirim ${dryRun ? "dry-run " : ""}${selected.length} alert go_dark dari ${candidatePool.length} kandidat sumber.`);
  if (requestedLimit > MAX_LIMIT) console.log(`Limit dibatasi maksimal ${MAX_LIMIT} alert.`);

  let prepared = 0;
  let success = 0;
  let failed = 0;

  for (let i = 0; i < selected.length; i += 1) {
    const row = selected[i];
    const mmsi = firstText(row, ["MMSI", "mmsi"]);
    const message = formatGoDarkMessage(row);

    if (dryRun) {
      console.log(`\n--- DRY RUN ${i + 1}/${selected.length} | MMSI ${mmsi} ---\n${message}`);
      prepared += 1;
    } else {
      try {
        const result = await sendTelegram(message, botToken, chatId);
        await appendLog({ status: "success", mmsi, httpStatus: result.httpStatus });
        success += 1;
        console.log(`[${i + 1}/${selected.length}] terkirim MMSI ${mmsi} message_id=${result.messageId ?? "-"}`);
      } catch (err) {
        failed += 1;
        await appendLog({
          status: "failed",
          mmsi,
          httpStatus: err?.httpStatus || "",
          error: err?.message || String(err),
        });
        console.error(`[${i + 1}/${selected.length}] gagal MMSI ${mmsi}: ${err?.message || err}`);
      }
    }

    if (i < selected.length - 1) await sleep(delayMs);
  }

  console.log(JSON.stringify({
    ok: failed === 0,
    dry_run: dryRun,
    require_gear: requireGear,
    selected: selected.length,
    prepared,
    sent: dryRun ? 0 : success,
    failed,
    input_file: INPUT_FILE,
    log_file: dryRun ? null : LOG_FILE,
  }, null, 2));

  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(JSON.stringify({
    ok: false,
    error: err?.message || String(err),
  }, null, 2));
  process.exitCode = 1;
});
