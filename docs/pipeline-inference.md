# Pipeline Inference — Samudra Aya AI
## Alur: Frontend → FastAPI → GFW API → LSTM Model → Hasil di Peta

---

## Komponen Utama

- **Browser** — tab AI di dashboard, tombol "Jalankan Inference"
- **FastAPI Server** — Hugging Face Space `https://ngenss12-inferencegfw.hf.space`
- **GFW API v3** — sumber data vessel track untuk inference
- **newcodinggfw.h5** — file model LSTM (gear, spoofing, godark)
- **LSTM Classifier** — model PyTorch bidirectional dengan attention pooling

---

## Alur Lengkap

```
Browser (tab AI)
  │
  │  1. setAiDefaultDates() → set rentang 30 hari terakhir
  │  2. Klik "Jalankan Inference"
  │
  ▼
runInference() di index.html
  │
  ├── checkInferenceServer()
  │     fetch https://ngenss12-inferencegfw.hf.space/health (timeout 5s)
  │     GAGAL → tampil pesan "Server tidak berjalan"
  │     OK → lanjut
  │
  ├── Animasi status: 5 stage × 20 detik
  │     "Mengambil data GFW..."
  │     "Memfilter vessel di Indonesia..."
  │     "Mengambil track per vessel..."
  │     "Menjalankan inference model..."
  │     "Menganalisis hasil..."
  │
  │  fetch GET https://ngenss12-inferencegfw.hf.space/inference/gfw
  │         ?start_date=YYYY-MM-DD
  │         &end_date=YYYY-MM-DD
  │         &max_vessels=5
  │         &task=all|gear|spoofing|godark
  ▼
FastAPI — /inference/gfw endpoint (api_server.py)
  │
  ▼
load_from_gfw_api() — inference_gfw.py
  │
  ├── LANGKAH 1: Discovery vessel
  │     POST GFW API /v3/events
  │       - dataset: fishing events only
  │       - limit: 200, sort: -start
  │       - timeout: 90 detik
  │     Filter Indonesia di Python (bbox lat/lon)
  │     Ekstrak vessel_id + MMSI unik
  │
  ├── LANGKAH 2: Fetch track per vessel (max N vessel)
  │     untuk setiap vessel_id:
  │       POST GFW API /v3/events?vessels=[vessel_id]
  │       - semua dataset (fishing + encounter + loitering)
  │       - timeout: 30 detik per vessel
  │       - sleep 0.4s antar request
  │     Hasilnya: sparse track (lat, lon, timestamp per event)
  │
  └── Returns: DataFrame
        kolom: mmsi, timestamp, lat, lon, speed, course,
               distance_from_shore, distance_from_port
```

---

## Preprocessing & Feature Engineering

```
DataFrame (sparse track per vessel)
  │
  ▼
clean_and_derive()
  │  - Sort by mmsi + timestamp
  │  - Hapus duplikat
  │  - Hitung dt (delta time antar poin)
  │  - Hitung step_km (haversine distance)
  │  - Derive: vx, vy, dspeed, accel
  │  - Derive: dcourse, turn_rate, abs_dcourse
  │  - Derive: pos_speed_knots, bearing, bearing_error
  │  - Derive: curvature, rolling MA5 features
  │  Total: 25 feature kolom
  │
  ▼
filter_jumps()
  │  Hapus poin dengan implied speed > 42 knots (GPS jump)
  │
  ▼
build_sequences()
  │  - Split per vessel + gap > 30 hari
  │  - Buat sliding window SEQ_LEN=120 poin, STRIDE=6
  │  - Pad segment pendek jika >= MIN_POINTS (20)
  │  Returns: X (N, 120, 25), groups (N,) = mmsi per sequence
  │
  ▼
apply_scaler()
     StandardScaler dari .h5 (fit saat training)
     X: (N, 120, 25) → normalized
```

---

## Model LSTM

```
Input: (batch, 120 timesteps, 25 features)
  │
  ▼
in_proj: Linear(25→192) + GELU + Dropout
  │
  ▼
BiLSTM: hidden=256, 2 layer, bidirectional
  Output: (batch, 120, 512)
  │
  ├── last hidden:  (batch, 512)
  ├── mean pooling: (batch, 512)
  ├── max pooling:  (batch, 512)
  └── attention:    (batch, 512)  ← AttentionPool
  │
  ▼
concat → (batch, 2048) → LayerNorm
  │
  ▼
embed: Linear(2048→256) + GELU + Dropout
  │
  ▼
CosineClassifier(256 → N kelas, scale=30)
  Output: logits per kelas
```

---

## 3 Task Inference

| Task | Kelas Output | Deteksi |
|------|-------------|---------|
| **gear** | drifting_longlines, set_longlines, set_gillnets, trawlers, trollers, dll | Jenis alat tangkap |
| **spoofing** | spoofing / not_spoofing | Manipulasi posisi AIS |
| **godark** | go_dark / not_dark | Mematikan AIS transponder |

---

## Agregasi Per Vessel

```
Per vessel: N sequences → N logit vectors
  │
  ▼
Logit adjustment (tau dari checkpoint)
  │  adj_logits = logits - tau × log_pi
  │
  ▼
Softmax → probs (N, C)
  │
  ▼
conf_score = max_prob × margin²
  │
  ▼
aggregate_vessel()
  │  - Ambil top-K sequence (keep_frac=15%, min 8)
  │  - Weighted average logits (weight = conf^3)
  │  - argmax → pred_label
  │
  └── Output per vessel:
        mmsi, pred_label, confidence, margin,
        n_sequences, n_used, probs (dict)
```

---

## Response ke Frontend

```
FastAPI async job returns JSON:
  { job_id, status: "pending" }

Browser polling:
  GET /inference/gfw/status/{job_id}

Saat selesai, FastAPI returns JSON:
  {
    elapsed_s, n_vessels, start_date, end_date,
    source: "gfw_events",
    vessels: [
      {
        mmsi: "...",
        last_lat, last_lon,
        tasks: {
          gear:     { pred_label, confidence, margin, probs },
          spoofing: { pred_label, confidence, margin, probs },
          godark:   { pred_label, confidence, margin, probs }
        }
      }
    ]
  }
  │
  ▼
Browser — renderAiResults() + plotAiMarkers()
  │
  ├── Marker di peta: warna = gear type
  │     ring merah jika spoofing/go dark terdeteksi
  │
  ├── Tooltip permanen: MMSI + gear + confidence %
  │
  └── Panel kiri: card per vessel
        gear confidence bar
        ⚠ alert jika spoofing / go dark
```

---

## File Kunci

| File | Fungsi |
|------|--------|
| `InferenceGFW/api_server.py` | FastAPI server di Hugging Face, endpoint `/inference/gfw`, `/inference/gfw/status/{job_id}`, `/inference/csv`, `/health` |
| `Inference/inference_gfw.py` | Load model dari .h5, preprocessing, inference, GFW API fetcher |
| `Inference/newcodinggfw.h5` | Model weights + scaler + label map (gear/spoofing/godark) |
| `index.html` — `runInference()` | Trigger inference, animasi status, render hasil |

---

## Menjalankan

```
Terminal 1 (Vite):
  cd D:\Lingga\samudra-aya-data
  npm run dev

Inference production:
  Hugging Face Space: https://ngenss12-inferencegfw.hf.space
```

Akses: `http://localhost:5173` → tab AI → Jalankan Inference
