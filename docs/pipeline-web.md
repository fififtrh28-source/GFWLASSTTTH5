# Pipeline Web — Samudra Aya
## Alur: GFW API → Vite Proxy → Frontend → Leaflet Map

---

## Komponen Utama

- **Browser** — menjalankan aplikasi React/HTML (Leaflet map)
- **Vite Dev Server** — lokal port 5173, merangkap API proxy
- **Vercel** — hosting production (serverless functions)
- **GFW API v3** — `gateway.api.globalfishingwatch.org/v3/events`
- **AISStream** — WebSocket live AIS `wss://stream.aisstream.io/v0/stream`

---

## Alur Data GFW Events

```
Browser (localhost:5173)
  │
  │  fetch GET /api/gfw/events?start_date=...&end_date=...
  ▼
Vite Dev Server (vite.config.ts — vercelApiPlugin)
  │  resolveHandler("/api/gfw/events") → api/gfw/events.js
  │  dynamic import via pathToFileURL (bypass Vite bundler)
  ▼
api/gfw/events.js (Node.js handler)
  │  1. Rate limit per IP
  │  2. Cek Redis/KV cache berdasarkan start_date + end_date
  │     HIT fresh → return langsung
  │  3. Baca GFW_TOKEN dari environment
  │  4. POST ke GFW API v3/events
  │     - datasets: [fishing, encounter, loitering]
  │     - geometry: Indonesia polygon (95°E–141°E, 11°S–6°N)
  │     - vesselTypes: ["FISHING"]
  │     - limit: 200, sort: -start
  │  4. Response ~60–90 detik (no timeout — API lambat)
  │  5. Simpan response ke Redis/KV cache
  │     Jika GFW gagal dan ada cache stale → return stale data
  ▼
GFW API v3 (eksternal)
  │  POST /v3/events
  │  Returns: { entries: [...200 events...], total: N }
  │
  │  Setiap entry:
  │    id, type (fishing/encounter/loitering)
  │    position: { lat, lon }
  │    vessel: { ssvid (MMSI), name, flag, id }
  │    start, end (ISO timestamp)
  ▼
api/gfw/events.js
  │  Returns: { events: [...entries...] }
  ▼
Browser — loadGfw() di index.html
  │  1. normalizeGfw(ev) → { source, key, id, type, lat, lon,
  │                           mmsi, name, flag, start, end, durationHours }
  │  2. processMarker(ev) → L.marker di Leaflet map
  │  3. Update stats panel (count per type)
  │  4. Simpan ke localStorage cache (TTL 10 menit)
  ▼
Leaflet Map
     Marker warna: hijau (fishing) | oranye (encounter) | kuning (loitering)
     Klik marker → sidebar detail kapal
```

---

## Alur Data AIS Live

```
Browser
  │  new WebSocket('wss://stream.aisstream.io/v0/stream')
  │  Send: { APIKey, BoundingBoxes (3 area Indonesia), FilterMessageTypes }
  ▼
AISStream WebSocket (eksternal)
  │  Push real-time: PositionReport | ShipStaticData
  ▼
Browser — parseAis(msg)
  │  Extract: mmsi, name, lat, lon, speed, course, heading
  ▼
processMarker(d)
  │  Icon: segitiga dengan rotasi heading, warna by speed
  │  Trail: simpan { lat, lon, t } max 120 poin
  ▼
Leaflet Map
     Auto-prune kapal tidak aktif > 10 menit
```

---

## Mode Tampilan

| Mode | Data | Trigger |
|------|------|---------|
| GFW  | Fishing events 30 hari | Auto-load saat buka |
| AIS  | Live position real-time | Switch tab AIS |
| AI   | GFW + AIS + inference | Switch tab AI |

---

## Loading State

```
loadGfw() dipanggil
  │
  ├── Cek localStorage cache (v7)
  │     HIT → tampil langsung (skip fetch)
  │     MISS → lanjut fetch
  │
  ├── Tampilkan: progress bar 5% + 3 badge "loading"
  │
  ├── setInterval crawl progress 1%/900ms (animasi ~90 detik)
  │
  ├── fetch /api/gfw/events (tunggu ~60–90 detik)
  │
  └── Selesai:
        progress bar 100% → hilang setelah 600ms
        badge: ✓ Fishing N | ✓ Encounter N | ✓ Loitering N → hilang 2 detik
        status: "GFW · N events"
        simpan ke localStorage
```

---

## File Kunci

| File | Fungsi |
|------|--------|
| `index.html` | Seluruh UI, Leaflet map, logika fetch & render |
| `api/gfw/events.js` | Handler server — rate limit, cache-first Redis/KV, fetch GFW API, filter Indonesia |
| `api/_redis.js` | Helper Redis/KV via REST API + local dev fallback |
| `api/_rate-limit.js` | Fixed-window rate limit per IP |
| `vite.config.ts` | Proxy `/api/*` ke handler lokal saat dev |
| `vercel.json` | Rewrite SPA + serverless functions saat production |
| `.env` | `GFW_TOKEN`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` (tidak di-commit) |

---

## Production (Vercel)

```
Browser
  │  fetch /api/gfw/events?...
  ▼
Vercel Edge
  │  api/gfw/events.js → Serverless Function (Node.js)
  ▼
GFW API v3
  │  (sama seperti dev, tapi timeout Vercel max 60 detik)
  ▼
Browser → Leaflet Map
```
