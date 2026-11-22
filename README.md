# APOTEK · SMART POS — PWA Architecture v1.4

## Fokus
End-to-End Functional Validation, Tenant Isolation Assurance & Production Hardening. Backend Google Apps Script dan Google Spreadsheet tetap menjadi sumber data utama.

## Perubahan v1.4
- Gateway memvalidasi origin sebelum mengirim respons iframe dan helper respons memvalidasi origin serta request ID secara independen.
- Payload argumen API dibatasi 5 MB; jumlah argumen tetap maksimum 30 dan metode wajib berada pada allowlist.
- Refresh record ditolak jika binding user/tenant/session tidak lengkap atau masa berlaku sudah habis. Rotasi tetap memakai ScriptLock.
- Namespace cache, draft, dan antrean lokal UI dipisahkan berdasarkan tenant sekaligus identitas user.
- Service Worker memakai cache v1.4 dan tetap hanya menyimpan shell statis.
- Ditambahkan `pwa/production-check.html` untuk pemeriksaan readiness browser yang tidak membaca atau menyimpan kredensial.
- Ditambahkan `VALIDATION_MATRIX.md` berisi hasil validasi statis dan matriks acceptance runtime.

## Deploy
1. Backup backend dan frontend produksi.
2. Terapkan `gas/Code.gs` dari paket ini ke Apps Script; pertahankan semua file/fungsi project yang memang dibutuhkan.
3. Deploy sebagai New version.
4. Pastikan origin HTTPS hosting telah dikonfigurasi melalui `configurePwaGatewayOrigins(['https://YOUR-HOSTING-ORIGIN'])`.
5. Isi `gasWebAppUrl` pada `pwa/pwa-config.js`.
6. Publikasikan seluruh folder `pwa/` ke hosting HTTPS.
7. Uji `production-check.html`, lalu jalankan seluruh acceptance matrix menggunakan tenant uji.
8. Clear site data/unregister service worker lama, kemudian buka kembali PWA.

## Peringatan penting
- Hasil validasi paket ini bersifat statis. Runtime GAS, autentikasi lintas-origin, tenant isolation, scanner kamera, transaksi, cetak, dan backup/restore belum diuji pada deployment.
- CacheService dapat meng-evict sesi lebih awal; perilakunya fail-closed, tetapi dapat meminta login ulang. Untuk deployment besar, gunakan session store durable.
- `getIntegrityRepairPlanVersion` masih belum tersedia pada backend sumber dan tidak di-allowlist.
- Jangan menandai transaksi offline sebagai berhasil sebelum backend mengonfirmasi commit.
- Namespace localStorage bukan batas keamanan. Semua akses data wajib tetap diverifikasi backend.

## File
- `gas/Code.gs`, `gas/Index.html`: backend dan fallback HtmlService.
- `pwa/index.html`, `pwa/app.html`: entry point dan UI operasional penuh.
- `pwa/api-bridge.js`, `pwa/pwa-config.js`: API transport dan konfigurasi publik.
- `pwa/sw.js`, `pwa/manifest.webmanifest`, `pwa/offline.html`: PWA shell.
- `pwa/production-check.html`: browser readiness checks.
- `scanner/`: scanner source.
- `VALIDATION_MATRIX.md`: acceptance tests, scope dan status.
