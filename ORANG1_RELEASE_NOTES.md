# Orang 1 — Catatan integrasi GitHub

Tanggal: 11 November 2026, Asia/Jakarta. Branch pekerjaan: `feat/orang1-inbound`; tujuan: `main`.

## Cakupan

Master SKU CRUD, GRN pending/verify/cancel, RFID simulation/edit/deactivate, validasi UUID/EPC, repository PostgreSQL transaksional, perlindungan relasi/ledger, dan audit Orang 1. Sertakan koleksi Postman QA dan Production GET-only beserta bukti tersanitasi. SQL audit disertakan sebagai artefak manual; proses release tidak menjalankan migrasi.

Saat meninjau `main`, ditemukan kontrak dashboard `price_idr`/`min_stock` dan URL RFID `/api/rfid/tags` serta `/api/rfid/encode`. Alias tersebut dipertahankan. Adapter request `sku`/`epc_code` mencari produk yang tepat, memvalidasi EPC, dan menerapkan aturan simulasi yang sama; SKU tidak ditemukan menghasilkan 404 tanpa mengganti produk. `location_code` legacy tidak menjalankan putaway. Respons sukses tetap memiliki `status: ok` serta `success/message/data`.

Regresi terbatas menemukan rollback fallback memory memperlakukan objek `settings` bersama sebagai array, sehingga konflik menjadi HTTP 500. Perbaikan hanya memulihkan array tabel yang dimutasi Inbound; objek pengaturan bersama dipertahankan. Tes duplicate EPC kini kembali 409 dan tidak menambah item/event.

## Validasi dan bukti

- **PREVIOUSLY TESTED:** 158 PASS, 0 FAIL, 4 SKIP pada laporan integrasi 9 November; bukti text tersedia di `tests/evidence/final-*.txt` dan pada frontend untuk 11 tes helper.
- **PREVIOUSLY TESTED:** Newman 11 November: capability 376 assertion PASS, strict 374 PASS, Production tujuh GET/24 PASS; 34 pemeriksaan tambahan PASS. Bukti `tests/postman/evidence/` dan `ORANG1_API_TEST_REPORT.md`. Angka ini tidak dihitung ulang sebagai tes release.
- **PASSED sebelum sinkronisasi:** backend build; enam regression test `tests/orang1-main-integration.test.ts` untuk kompatibilitas `main` dan rollback.
- **NOT RUN:** pengulangan seluruh collection Postman/Newman, write Production, migrasi/deployment, dan publish MQTT bisnis selama release.

Artefak tes sebelumnya berasal dari working tree sebelum commit, sehingga tidak mengandung SHA commit release. Perubahan release pada adapter/alias dan rollback dijelaskan di atas; bukti lama tidak diklaim sebagai eksekusi terhadap SHA hasil merge. Build dan regresi terbatas diulang setelah sinkronisasi, lalu dicatat pada PR/laporan release.

## Pelestarian pekerjaan tim dan lokal

Konfigurasi lokal yang telah berubah sebelum pengembangan Orang 1 (`src/config/db.ts`, `src/config/mqtt.ts`, `src/server.ts`, `tsconfig.json`, `docker-compose.yml`, serta penghapusan `.env.example`) diamankan dalam stash bernama `preserve pre-existing local configuration before Orang 1 release 2026-11-11`. Stash tersebut tidak dipublikasikan atau diterapkan di atas konfigurasi terbaru `main`. Dukungan SSL, JWT, password hashing, route modul lain, dan konfigurasi terbaru anggota tim dipertahankan.

`.env`, output build, snapshot metadata/data Production mentah, dan screenshot sesi lokal tidak disertakan dalam commit. Semuanya tetap berada di lokal bila sudah tersedia. Bukti Postman yang dipublikasikan hanya memuat status, waktu, nama assertion dan statistik, tanpa response body Production atau credential.

Tidak ada perubahan schema/UUID/PK/FK atau data Production. DIBATALKAN/DAMAGED masih bergantung pada kemampuan CHECK database: 409 merupakan perilaku aman bila belum didukung. Merge GitHub bukan deployment dan tidak memberikan izin menjalankan migrasi atau pengujian tulis Production.
