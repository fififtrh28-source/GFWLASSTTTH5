#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { formatTelegramAlert } from "../api/telegram/alert.js";

function loadDotEnv() {
  for (const fileName of [".env", ".env.local", ".env.lokal"]) {
    const envPath = path.join(process.cwd(), fileName);
    if (!fs.existsSync(envPath)) continue;
    for (const line of fs.readFileSync(envPath, "utf-8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 1) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, "");
      if (key && !(key in process.env)) process.env[key] = value;
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

async function main() {
  loadDotEnv();
  const args = parseArgs(process.argv.slice(2));
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!botToken || !chatId) {
    throw new Error("TELEGRAM_BOT_TOKEN atau TELEGRAM_CHAT_ID belum diisi di environment/.env.local.");
  }

  const payload = {
    level: args.level || "HIGH",
    candidate_type: args.candidate_type || args.alert_type || "godark",
    MMSI: args.mmsi || args.MMSI || "-",
    gear: args.gear || "-",
    gear_probability: args.gear_probability || args.gear_confidence || "",
    pred_label: args.pred_label || args.candidate_type || args.alert_type || "godark",
    score: args.score || "",
    lat: args.lat || args.latitude || "",
    lon: args.lon || args.longitude || "",
    source: args.source || "AI inference batch latest",
    time: args.time || new Date().toLocaleString("id-ID", { timeZone: "Asia/Bangkok" }),
    indication: args.indication || "",
    map_url: args.map_url || "",
  };
  const text = args.message || formatTelegramAlert(payload);

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
    throw new Error(data?.description || `Telegram HTTP ${response.status}`);
  }

  console.log(JSON.stringify({
    ok: true,
    message_id: data?.result?.message_id ?? null,
    candidate_type: payload.candidate_type,
    mmsi: payload.MMSI,
  }, null, 2));
}

main().catch((err) => {
  console.error(JSON.stringify({
    ok: false,
    error: err?.message || String(err),
  }, null, 2));
  process.exitCode = 1;
});
