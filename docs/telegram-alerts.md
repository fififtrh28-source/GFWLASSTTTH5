# Telegram Alert Dashboard H5

Fitur ini menambahkan kanal distribusi alert Telegram tanpa mengubah logic kandidat, CSV, marker, atau hasil inference/rule-based.

## File yang ditambahkan/diubah

- `api/telegram/alert.js`: endpoint `POST /api/telegram/alert` untuk mengirim alert ke Telegram.
- `scripts/send-telegram-alert.js`: helper CLI untuk test kirim alert.
- `.env.example`: contoh variabel `TELEGRAM_BOT_TOKEN` dan `TELEGRAM_CHAT_ID`.
- `index.html`: tombol `Kirim Alert Telegram` pada panel detail kandidat aktif.
- `public/assets/ITS.png` dan `public/assets/OceanNexus.png`: asset branding header ITS + Ocean Nexus.

## Konfigurasi token

Salin `.env.example` ke `.env.local`, lalu isi:

```env
TELEGRAM_BOT_TOKEN=isi_token_bot_dari_botfather
TELEGRAM_CHAT_ID=isi_chat_id_tujuan
```

Setelah env diisi, jalankan ulang dashboard H5:

```bash
npm.cmd run dev -- --port 5174
```

Port H5 tetap `http://127.0.0.1:5174/`, bukan 5173.

## Test dari dashboard

1. Buka dashboard H5 di `http://127.0.0.1:5174/`.
2. Buka kandidat kapal aktif, misalnya `godark`, `spoofing`, atau `transshipment`.
3. Di panel detail kanan, klik `Kirim Alert Telegram`.
4. Status berhasil/gagal tampil di panel yang sama.

Jika token atau chat ID belum diisi, dashboard menampilkan error konfigurasi dan tetap berjalan normal.

## Test dari CLI

```bash
node scripts/send-telegram-alert.js --candidate-type godark --mmsi 533200931 --gear drifting_longlines --score 0.903 --lat 4.62670 --lon 103.57530
```

## Kirim batch alert H5

Script batch membaca `KAPAL YG TERDETEKSI/final_h5_alert_predictions.csv`, mengambil hanya kandidat `go_dark`, mengurutkan berdasarkan `score`/`go_dark_probability` tertinggi, lalu mengirim maksimal 10 pesan terpisah.

```bash
node scripts/send-telegram-batch-alerts.js --limit 10
```

Untuk cek tanpa mengirim pesan sungguhan:

```bash
node scripts/send-telegram-batch-alerts.js --limit 3 --dry-run
```

Script ini tidak mengirim spoofing/transshipment dari H5 karena pipeline tersebut belum tersedia pada output inference H5.

Log status kirim disimpan terpisah di:

```text
KAPAL YG TERDETEKSI/telegram_alert_send_log.csv
```

File log ini tidak mengganti output rule-based atau output H5.
