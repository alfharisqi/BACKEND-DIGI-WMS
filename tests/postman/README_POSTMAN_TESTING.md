# Panduan Postman DigiWMS Orang 1

Gunakan **QA CRUD** untuk pengujian tulis di server disposable yang disediakan di sini. Gunakan **Production Read Only** untuk demonstrasi data existing pada `http://localhost:5000`. Port 5000 terhubung ke Supabase Production; jangan mengarahkan koleksi CRUD ke sana.

## File yang diimpor

| Collection | Environment | Kegunaan |
|---|---|---|
| `DigiWMS_Orang1_QA_CRUD.postman_collection.json` | `DigiWMS_Orang1_QA.postman_environment.json` | 76 request berurutan, lima folder; setup, CRUD, validasi, audit |
| `DigiWMS_Orang1_Production_ReadOnly.postman_collection.json` | `DigiWMS_Orang1_Production_ReadOnly.postman_environment.json` | Tepat tujuh GET, tanpa operasi tulis |

Collection menggunakan format v2.1 dan skrip `pm.test`/`pm.expect`. File environment tidak menyimpan kredensial atau UUID Production. ID diambil dari respons; variabel runtime bukan nilai yang perlu diketik manual.

## Menyiapkan backend QA yang benar

Jalankan PowerShell di:

```powershell
Set-Location 'D:\SEMESTER 7\digiwms\BACKEND-DIGI-WMS'
```

Prasyarat: dependency backend sudah terpasang, Node.js yang dapat menjalankan `node --import tsx`, dan executable PostgreSQL 16 (`initdb.exe`, `pg_ctl.exe`). Harness default menggunakan `C:\Program Files\PostgreSQL\16\bin`, port database **55432**, port API **5001**. Kedua port harus kosong. Jika lokasi PostgreSQL berbeda, set hanya pada proses terminal:

```powershell
$env:ORANG1_POSTMAN_PG_BIN = 'C:\Program Files\PostgreSQL\16\bin'
```

Newman 6.2.3 dan validator Ajv dipasang **di TEMP**, bukan global dan bukan dependency proyek:

```powershell
$postmanTools = Join-Path $env:TEMP 'digiwms-postman-tools'
npm install --prefix $postmanTools --no-audit --no-fund newman@6.2.3 ajv-draft-04@1.0.0
```

Schema publik resmi sudah disertakan sebagai `collection-schema-v2.1.json`. Untuk mengunduh ulang jika diperlukan:

```powershell
Invoke-WebRequest 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' -OutFile 'tests/postman/collection-schema-v2.1.json'
```

Untuk membuka server QA bagi Postman GUI, jalankan dan biarkan terminal ini aktif:

```powershell
node --import tsx tests/postman/run.ts --serve
```

Untuk fixture yang sengaja menggunakan batas status seperti Production:

```powershell
node --import tsx tests/postman/run.ts --serve --strict
```

Tunggu pesan **Disposable Postman QA ready**. Tutup server pertama dengan **Ctrl+C** sebelum mengganti mode. Harness membuat cluster baru dengan nama direktori `digiwms-postman-pg-<random>` di TEMP, memverifikasi `SHOW data_directory` sama persis dengan direktori miliknya, dan membuat schema `orang1_postman_<random>`. Ia tidak menerima `DATABASE_URL` sebagai target fixture; URL QA ditetapkan khusus ke cluster baru pada 55432. Repository QA diinjeksi ke routes Orang 1; inisialisasi `server.ts` dan koneksi MQTT tidak dijalankan.

Fixture dibuat dari definisi tabel sintetis, termasuk audit test-only. **Tidak ada file migrasi yang dibaca atau dijalankan**, tidak ada perubahan constraint existing. Mode capability menyertakan DIBATALKAN/DAMAGED sejak CREATE TABLE fixture; strict tidak menyertakannya. Pada shutdown normal, schema milik tes dihapus dan cluster milik tes dihentikan. Direktori TEMP yang tersisa hanya berisi data QA sintetis; harness tidak melakukan recursive delete.

### Mengapa guard ini diperlukan

Koleksi hanya mengizinkan alamat loopback port 5001. Sebelum setiap request, skrip mengirim GET health dan memeriksa attestation server disposable, schema, mode, MQTT spy, serta identitas instance (`qaNonce`). Server juga menolak request tulis tanpa header attestation dan ID run. `qaNonce` adalah pengenal instance QA lokal, bukan token akun Production. Nilainya tidak disimpan dalam environment yang dibagikan.

Apabila target salah, URL request diganti ke loopback port 1, request dilewati pada runtime yang mendukung `skipRequest`, dan urutan dihentikan. Assertion gagal menandai `qaFailed`; variabel dependensi yang belum terisi juga menghentikan suite. Ini tambahan atas isolasi server/database, bukan pengganti isolasi. Jangan melepas guard untuk memakai backend existing atau Docker database umum.

## Langkah penggunaan Postman

1. Buka aplikasi Postman Desktop terbaru. Jika memakai versi web, aktifkan Desktop Agent agar localhost dapat diakses.
2. Klik **Import**, pilih salah satu file `*.postman_collection.json`, lalu impor. Tidak perlu mengimpor `generate.cjs`, `scenarios.json`, atau schema JSON.
3. Klik **Import** kembali dan pilih file environment yang pasangannya sesuai tabel di atas.
4. Pilih environment di kanan atas. Pastikan QA menggunakan `http://127.0.0.1:5001`, sedangkan Production Read Only menggunakan `http://localhost:5000`.
5. Untuk demonstrasi GET Production, jalankan health, daftar produk, lalu detail produk. Jalankan daftar GRN sebelum detail GRN dan daftar tag sebelum detail tag. Request daftar menangkap UUID otomatis. Jika daftar kosong, detail tidak dapat diuji dan urutan berhenti; jangan menyebut detail PASS.
6. Untuk CRUD QA, hidupkan server disposable dan jalankan **01.00 — Mulai run QA** dahulu. Request ini membuat ID run/SKU/PO/EPC baru dan mengambil identitas server. Jangan mengetik UUID seed.
7. Buka **01.01 — CREATE produk tanpa relasi**, tab **Body → raw → JSON**, lalu **Send**. Contoh body memakai `{{qaSku}}`, nama sintetis, harga 12500.5, minimum stok 2. Response 201 menyimpan `productId`.
8. Jalankan 01.02 dan 01.03 untuk produk relasi dan reassignment yang berbeda. Jalankan 01.04/01.05 untuk memeriksa daftar/detail. UUID `productId` digunakan utuh pada URL.
9. Jalankan 01.06 untuk PUT perubahan nama, lalu 01.07 untuk membaca nilai yang telah disimpan. PUT membutuhkan seluruh field produk yang diwajibkan, bukan hanya nama.
10. Jalankan negative cases folder produk sesuai urutan. Status 400/404/409 pada request ini adalah **expected**, sehingga assertion yang benar harus PASS.
11. Jalankan 01.08 DELETE hanya untuk produk QA tanpa relasi yang dibuat 01.01. Request berikutnya memastikan GET menghasilkan 404. Produk kedua tetap dipakai untuk relasi tag; jangan mengganti ID target DELETE dengan ID existing.
12. Jalankan folder GRN dari awal: create GRN verifikasi dan create GRN cancel terpisah, baca detail, PUT ketika pending, lalu baca ulang. Tanggal `2026-11-05` harus tetap tanggal kalender yang sama.
13. Jalankan verify: status menjadi SELESAI, `verified_at` terisi, RFID tetap MENUNGGU_TAGGING. Verifikasi ulang dan edit/cancel GRN selesai harus 409. Endpoint verify tidak menerima actor palsu.
14. Jalankan cancel GRN kedua. Tanpa alasan harus 400. Capability menghasilkan 200/DIBATALKAN dan audit reason; strict menghasilkan 409 tanpa perubahan maupun audit CANCEL. Pembatalan berulang tetap ditolak. Jangan mengubah expected status agar kegagalan tampak lulus.
15. Jalankan folder RFID berurutan. Tiga request encode menggunakan EPC 24 hex yang dihasilkan tiap run dan tipe STANDARD_LABEL, ON_METAL, HARD_TAG. Body mengirim `product_id`, `epc_custom`, `type`, `mode: simulation`, dan opsional `grn_id`. GRN tidak memiliki kolom product_id pada fixture Supabase ini; relasi dibentuk melalui item.
16. Periksa response encode: `data.tag`, `data.item`, mode simulation, `hardware_confirmed: false`. Item harus ENCODED, bukan otomatis IN_STOCK. Jalankan edit tipe dan reassignment tag yang belum terikat GRN/transaksi. EPC immutable dan perubahan tag bertransaksi harus ditolak.
17. Jalankan deactivate tag khusus QA. Capability menghasilkan DAMAGED, sementara strict 409. Alasan wajib. GET detail/audit memastikan EPC, item, dan riwayat tetap ada; percobaan reuse EPC harus 409.
18. Perhatikan **status HTTP** di panel response, JSON di tab **Body**, dan hasil assertion di **Test Results**. Response aplikasi normal memakai `{success,message,data}`; error aplikasi memakai `{success:false,message}`. JSON malformed ditolak parser Fastify dengan `{statusCode,error,message,...}`, sehingga tes kasus itu sengaja memakai assertion bentuk native Fastify.
19. Untuk bukti lengkap, pilih collection QA → **Run collection**, pilih semua lima folder dalam urutan asli, satu iteration, lalu **Run**. Jangan menjalankan folder dependen sebagai suite mandiri. Jalankan sekali pada capability dan sekali pada strict; ganti server dan mulai dari 01.00 pada setiap run. Untuk ulang, mulai 01.00 agar identifier baru; jangan mengulang POST lama tanpa reset run.
20. Simpan bukti dari hasil Runner (ekspor hasil jika UI/plan menyediakan), atau gunakan Newman di bawah. Screenshot boleh diambil dari hasil aktual dengan nama collection, mode fixture, status HTTP, dan assertions terlihat. Hindari menampilkan credential atau isi `.env`. Ekspor environment hanya setelah mengosongkan variabel runtime; file template yang disediakan sudah kosong dan aman dibagikan.

## Eksekusi otomatis dan bukti yang bisa diulang

Satu perintah berikut memvalidasi schema/import SDK, menguji guard, membuat PostgreSQL disposable, menjalankan capability dan strict, memeriksa database secara langsung, menutup QA, lalu menjalankan tujuh GET Production:

```powershell
node --import tsx tests/postman/run.ts
node tests/postman/report.cjs
```

Jika Production tidak tersedia atau hanya QA yang ingin diuji:

```powershell
node --import tsx tests/postman/run.ts --qa-only
```

Perintah `report.cjs` merender Markdown/HTML dari tiga file hasil terakhir, lengkap dengan waktu masing-masing. Jalankan sesudah suite penuh; setelah `--qa-only`, bukti Production lama tidak menjadi bukti pengujian ulang Production. Jangan menjalankan perintah otomatis ketika server `--serve` masih memakai port 5001. Tidak perlu mengedit `.env` atau Docker Compose. Default Production berada di port 5000 dan koleksinya tidak memiliki request atau skrip mutasi.

Alternatif Newman CLI, dengan server `--serve` **sudah aktif** pada terminal terpisah:

```powershell
$newman = Join-Path $env:TEMP 'digiwms-postman-tools\node_modules\.bin\newman.cmd'
& $newman run tests/postman/DigiWMS_Orang1_QA_CRUD.postman_collection.json -e tests/postman/DigiWMS_Orang1_QA.postman_environment.json --bail --reporters cli,junit --reporter-junit-export tests/postman/evidence/manual-qa.xml
& $newman run tests/postman/DigiWMS_Orang1_Production_ReadOnly.postman_collection.json -e tests/postman/DigiWMS_Orang1_Production_ReadOnly.postman_environment.json --bail --reporters cli,junit --reporter-junit-export tests/postman/evidence/manual-production-readonly.xml
```

Jangan mengekspor raw JSON reporter Production untuk dibagikan tanpa sanitasi: reporter mentah dapat memuat payload/headers/environment. Runner bawaan menyimpan ringkasan tersanitasi, nama assertion, status, dan waktu saja. Pemeriksaan PostgreSQL internal berada di `integration-checks.json`; itu **bukan request Postman**. `summary.json` memisahkan item koleksi dari HTTP request tambahan GET attestation. Jangan menggandakan jumlah assertion akibat entri callback request pada objek execution Newman.

File `guard-*.json` sengaja mengandung kegagalan yang disuntikkan untuk membuktikan target salah/setup gagal dihentikan; hasil ini dilaporkan sebagai uji guard terpisah, tidak digabung menjadi FAIL koleksi bisnis. `ORANG1_API_TEST_REPORT.md` dan `evidence/runner-report.html` dibuat dari hasil yang benar-benar dieksekusi. Tidak ada screenshot Postman GUI yang diklaim dalam paket ini.

## Kontrak penting untuk presentasi

- POST produk/GRN/encode menghasilkan 201; operasi sukses lain 200. UUID tidak dikonversi menjadi integer.
- Harga native Supabase `unit_price` dan minimum `min_stock_threshold`; GET juga memberi alias `price` dan `min_stock_alert` untuk UI.
- STANDARD_LABEL → `Label Biasa (UHF)`, ON_METAL → `On-Metal (Logam/Cairan)`, HARD_TAG → `Hard Tag (Aset)`.
- GRN pending → SELESAI lewat verify; cancel pending yang belum berdampak pada relasi/ledger hanya jika constraint mendukung DIBATALKAN.
- ENCODED tidak berarti encoding chip fisik, putaway, atau pergerakan stok. Deactivate hanya untuk tag aman dan jika DAMAGED didukung.
- Audit diperiksa lewat detail GRN/tag; audit produk, ledger, orphan, dan item native diperiksa langsung di PostgreSQL QA. Tidak ada endpoint audit tambahan.
- Health `POSTGRESQL_DOCKER` existing tidak membuktikan sumber database. Harness QA membuktikan identitas cluster sebelum menyediakan HTTP server.

## Referensi resmi

[Format Collection v2.1](https://schema.postman.com/json/collection/v2.1.0/docs/index.html), [pm.execution dan penghentian urutan](https://learning.postman.com/docs/tests-and-scripts/write-scripts/postman-sandbox-reference/pm-execution/), [opsi Newman](https://learning.postman.com/docs/collections/using-newman-cli/newman-options/). Dukungan guard juga dieksekusi dengan Newman 6.2.3, bukan hanya diasumsikan dari dokumentasi.
