# Public Dashboard Deploy

Dashboard H5 ini bisa dipublikasikan dengan Vercel. GitHub Pages tidak disarankan karena dashboard memakai endpoint `api/` untuk GFW, inference proxy, dan Telegram alert.

## URL Lokal

```bash
npm.cmd run dev -- --port 5174
```

Lokal H5 tetap:

```text
http://127.0.0.1:5174/
```

## Data Static Dashboard

Dashboard membaca CSV/gambar lokal seperti:

- `KAPAL YG TERDETEKSI/scene_candidates_godark_spoofing_transshipment.csv`
- `KAPAL YG TERDETEKSI/scene_candidates_summary.csv`
- `new/metadata/*.csv`
- `Dataset_Test_Enriched/.../ais_kalman_25seq_per_mmsi.csv`
- `KAPAL YG TERDETEKSI/SENTINEL1_SCENE_MAPS/*`

Script berikut menyalin file yang dibutuhkan ke `public/` agar ikut deploy:

```bash
npm run prepare:public-data
```

`npm run build` akan menjalankan script ini otomatis sebelum `vite build`.

## Deploy ke Vercel

1. Push repo ke GitHub.
2. Buka Vercel, pilih `Add New Project`.
3. Import repo `fififtrh28-source/GFWLASSTTTH5`.
4. Framework preset: `Vite`.
5. Build command:

```bash
npm run build
```

6. Output directory:

```text
dist
```

7. Isi Environment Variables di Vercel:

```env
GFW_TOKEN=...
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
INFERENCE_URL=https://ngenss12-inferencegfw.hf.space
```

8. Klik Deploy.

Setelah deploy selesai, Vercel memberi URL publik seperti:

```text
https://nama-project.vercel.app
```

URL tersebut bisa dibuka orang lain.

## Catatan Keamanan

Jangan commit `.env`, `.env.local`, atau `.env.lokal`. Token harus diisi di Vercel Environment Variables.
