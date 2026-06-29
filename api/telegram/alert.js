import fs from "node:fs/promises";
import path from "node:path";
import { applyRateLimit } from "../_rate-limit.js";

const LOG_FILE = path.join(process.cwd(), "KAPAL YG TERDETEKSI", "telegram_alert_send_log.csv");

function cleanText(value, fallback = "-") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function numberFrom(value) {
  if (value === null || value === undefined || value === "") return null;
  const cleaned = String(value).replace("%", "").trim();
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function percentText(value) {
  const n = numberFrom(value);
  if (n === null) return "";
  const pct = Math.abs(n) <= 1 ? n * 100 : n;
  return `${pct.toFixed(1)}%`;
}

function normalizeAlertType(value) {
  const raw = String(value || "").toLowerCase().replace(/[\s-]+/g, "_");
  if (raw === "godark" || raw === "go_dark") return "go_dark";
  if (raw.includes("spoof")) return "spoofing";
  if (raw.includes("transship")) return "transshipment";
  return raw || "alert";
}

function titleFor(type) {
  switch (normalizeAlertType(type)) {
    case "go_dark": return "GO DARK";
    case "spoofing": return "SPOOFING";
    case "transshipment": return "TRANSSHIPMENT";
    default: return String(type || "ALERT").replace(/_/g, " ").toUpperCase();
  }
}

function indicationFor(type) {
  switch (normalizeAlertType(type)) {
    case "go_dark":
      return "pola trajectory AIS menyerupai aktivitas go dark.";
    case "spoofing":
      return "pola trajectory AIS menyerupai manipulasi/spoofing posisi.";
    case "transshipment":
      return "pola jarak, waktu, dan kedekatan kapal menyerupai indikasi transshipment.";
    default:
      return "pola kandidat kapal memenuhi aturan alert aktif.";
  }
}

function formatCoordinate(lat, lon) {
  const latNum = numberFrom(lat);
  const lonNum = numberFrom(lon);
  if (latNum === null || lonNum === null) return "-";
  return `${latNum.toFixed(5)}, ${lonNum.toFixed(5)}`;
}

function mapUrlFor(lat, lon, provided) {
  if (provided) return String(provided);
  const latNum = numberFrom(lat);
  const lonNum = numberFrom(lon);
  if (latNum === null || lonNum === null) return "";
  return `https://www.google.com/maps?q=${latNum.toFixed(6)},${lonNum.toFixed(6)}`;
}

export function formatTelegramAlert(payload = {}) {
  const type = normalizeAlertType(payload.candidate_type || payload.alert_type || payload.pred_label);
  const level = cleanText(payload.level || "HIGH").toUpperCase();
  const score = percentText(payload.score || payload.probability || payload.prediction_probability);
  const gearScore = percentText(payload.gear_probability || payload.gear_confidence);
  const gear = cleanText(payload.gear || payload.gear_label || payload.Ship_Type || payload.gfw_shiptype);
  const gearLine = gearScore ? `${gear} (${gearScore})` : gear;
  const predLabel = cleanText(payload.pred_label || type);
  const predLine = score ? `${predLabel} (${score})` : predLabel;
  const source = cleanText(payload.source || "AI inference batch latest");
  const sentTime = cleanText(payload.time || new Date().toLocaleString("id-ID", { timeZone: "Asia/Bangkok" }));
  const indication = cleanText(payload.indication || indicationFor(type));
  const mapUrl = mapUrlFor(payload.lat, payload.lon, payload.map_url);
  const mapLine = mapUrl ? `Buka lokasi di peta: ${mapUrl}` : "Buka lokasi di peta";

  return [
    `[${level}] ${titleFor(type)} ALERT`,
    `MMSI: ${cleanText(payload.MMSI || payload.mmsi)}`,
    `Gear: ${gearLine}`,
    `Prediksi: ${predLine}`,
    `Koordinat: ${formatCoordinate(payload.lat, payload.lon)}`,
    `Sumber: ${source}`,
    `Waktu: ${sentTime}`,
    `Indikasi: ${indication}`,
    "",
    mapLine,
  ].join("\n");
}

async function readPayload(req) {
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body); } catch { return { message: req.body }; }
  }
  if (!req.readable) return {};

  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf-8");
  if (!text.trim()) return {};
  try { return JSON.parse(text); } catch { return { message: text }; }
}

function csvEscape(value) {
  const text = String(value ?? "");
  if (!/[",\n\r]/.test(text)) return text;
  return `"${text.replaceAll('"', '""')}"`;
}

async function appendLog({ status, mmsi, candidateType, httpStatus = "", error = "" }) {
  const header = "sent_at_utc,status,mmsi,candidate_type,http_status,error\n";
  const row = [
    new Date().toISOString(),
    status,
    mmsi,
    candidateType,
    httpStatus,
    error,
  ].map(csvEscape).join(",") + "\n";

  try {
    await fs.mkdir(path.dirname(LOG_FILE), { recursive: true });
    try { await fs.access(LOG_FILE); }
    catch { await fs.writeFile(LOG_FILE, header, "utf-8"); }
    await fs.appendFile(LOG_FILE, row, "utf-8");
  } catch (err) {
    console.warn("Telegram alert log write failed:", err?.message || err);
  }
}

export default async function handler(req, res) {
  const allowed = await applyRateLimit(req, res, {
    name: "telegram-alert",
    limit: 30,
    windowSeconds: 10 * 60,
  });
  if (!allowed) return;

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Method not allowed. Use POST." });
  }

  const payload = await readPayload(req);
  const candidateType = normalizeAlertType(payload.candidate_type || payload.alert_type || payload.pred_label);
  const mmsi = cleanText(payload.MMSI || payload.mmsi);
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!botToken || !chatId) {
    const error = "TELEGRAM_BOT_TOKEN atau TELEGRAM_CHAT_ID belum diisi.";
    await appendLog({ status: "failed", mmsi, candidateType, error });
    return res.status(501).json({
      ok: false,
      error,
      detail: "Isi variabel tersebut di .env.local, lalu jalankan ulang dashboard H5.",
    });
  }

  const text = payload.message ? String(payload.message) : formatTelegramAlert(payload);

  try {
    const upstream = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: false,
      }),
      signal: AbortSignal.timeout(15000),
    });
    const data = await upstream.json().catch(() => null);

    if (!upstream.ok || data?.ok === false) {
      const detail = data?.description || `HTTP ${upstream.status}`;
      await appendLog({ status: "failed", mmsi, candidateType, httpStatus: upstream.status, error: detail });
      return res.status(upstream.status || 502).json({
        ok: false,
        error: "Telegram alert gagal dikirim.",
        detail,
      });
    }

    await appendLog({ status: "success", mmsi, candidateType, httpStatus: upstream.status });
    return res.json({
      ok: true,
      sent_at: new Date().toISOString(),
      mmsi,
      candidate_type: candidateType,
      telegram_message_id: data?.result?.message_id ?? null,
    });
  } catch (err) {
    const detail = err?.message || "Telegram request failed";
    await appendLog({ status: "failed", mmsi, candidateType, error: detail });
    return res.status(502).json({
      ok: false,
      error: "Telegram alert gagal dikirim.",
      detail,
    });
  }
}
