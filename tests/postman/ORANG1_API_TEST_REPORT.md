# Laporan API Testing DigiWMS Orang 1

## A. Tujuan API Testing

Memvalidasi Master SKU, penerimaan GRN, dan registrasi RFID melalui kontrak Fastify yang tersedia, termasuk input invalid, konflik bisnis, UUID, integritas relasi, audit, dan batas status database. Artefak ditujukan untuk pengujian ulang dan bukti presentasi kampus.

## B. Lingkungan Pengujian

Branch backend/frontend diperiksa: **feat/orang1-inbound**. Perubahan lokal sebelum tugas dipertahankan. Pekerjaan ini menambahkan artefak di tests/postman; tidak memperbaiki kode aplikasi karena tidak ditemukan bug aplikasi pada skenario yang dijalankan.

QA: Fastify loopback 5001, PostgreSQL 16 cluster baru milik proses pada port 55432. SHOW data_directory diverifikasi sama persis dengan direktori TEMP yang dibuat harness. Setiap mode mendapat schema acak berbeda dan fixture sintetis. Repository diinjeksi khusus QA; publisher diinjeksi sebagai spy, tanpa koneksi broker. Definisi fixture termasuk tabel audit dibuat langsung di schema disposable; tidak ada migrasi SQL yang dibaca/dijalankan dan tidak ada ALTER constraint Production.

Capability mendukung DIBATALKAN dan DAMAGED. Strict sengaja meniru batas CHECK yang terakhir diketahui pada Production. Hasil strict bukan pemeriksaan ulang metadata Production saat ini. Default connectionString QA ditetapkan dalam harness, tidak diambil dari DATABASE_URL. Import modul konfigurasi aplikasi tidak menjalankan init/check database/MQTT; routes selalu menggunakan repository/publisher QA yang diinjeksi.

Production existing: localhost:5000, sumber Supabase berdasarkan konteks konfigurasi yang telah diverifikasi sebelumnya. Hanya tujuh GET koleksi read-only dijalankan. Health POSTGRESQL_DOCKER tidak digunakan sebagai bukti identitas database. Tidak ada inspeksi isi backup, perubahan environment, Docker, UUID/PK/FK existing, modul tim lain, commit, atau push.

Waktu eksekusi bukti terakhir:

- qa-capability: 11/11/2026, 11.50.58 WIB–11/11/2026, 11.51.06 WIB.
- qa-strict: 11/11/2026, 11.51.06 WIB–11/11/2026, 11.51.14 WIB.
- production-readonly: 11/11/2026, 11.51.14 WIB–11/11/2026, 11.51.17 WIB.

## C. Daftar Endpoint

Kontrak ditelusuri dari routes.ts, service.ts, repository.ts, validation.ts, schema-contract.ts, konfigurasi db/server, klien API frontend, serta tes existing. Ada 16 endpoint Orang 1 dan satu health check.

| No | Modul | Method | Endpoint | Tujuan |
|---|---|---|---|---|
| 1 | Master SKU | GET | /api/products | Daftar, harga, minimum, stok tersimpan |
| 2 | Master SKU | GET | /api/products/:id | Detail UUID / 404 |
| 3 | Master SKU | POST | /api/products | Create produk QA, 201 |
| 4 | Master SKU | PUT | /api/products/:id | Update field lengkap, UUID tetap |
| 5 | Master SKU | DELETE | /api/products/:id | Hapus hanya produk QA tanpa stok/relasi |
| 6 | Inbound GRN | GET | /api/inbound/grn | Daftar penerimaan |
| 7 | Inbound GRN | GET | /api/inbound/grn/:id | Detail, tanggal kalender, audit_history |
| 8 | Inbound GRN | POST | /api/inbound/grn | Create pending, 201 |
| 9 | Inbound GRN | PUT | /api/inbound/grn/:id | Update pending yang belum terkait transaksi |
| 10 | Inbound GRN | PATCH | /api/inbound/grn/:id/verify | Pending ke SELESAI sekali |
| 11 | Inbound GRN | PATCH | /api/inbound/grn/:id/cancel | Reason wajib, capability 200 / strict 409 |
| 12 | RFID | GET | /api/tags | Daftar, legacy EPC tetap terbaca |
| 13 | RFID | GET | /api/tags/:id | Detail, relasi, audit_history |
| 14 | RFID | POST | /api/tags/encode | Registrasi simulasi tag + item ENCODED, 201 |
| 15 | RFID | PATCH | /api/tags/:id | Koreksi tipe/reassignment aman, EPC immutable |
| 16 | RFID | PATCH | /api/tags/:id/deactivate | Reason wajib, capability 200 / strict 409 |
| 17 | Health | GET | /api/health | Liveness; identitas QA khusus pada harness |

Body produk: sku, name, category, price, min_stock_alert; native Supabase menyimpan unit_price/min_stock_threshold. Body GRN: po_number, supplier_name, total_qty, receipt_date. GRN produk ditautkan melalui items.grn_id, bukan memaksakan kolom product_id yang tidak ada. Body encode: product_id, epc_custom, type, mode: simulation, opsional grn_id. Body edit tag hanya field yang didukung; cancel/deactivate memakai reason. Semua response aplikasi sukses memakai success/message/data, encode juga mempertahankan field legacy top-level.

## D. Skenario Pengujian

- Produk: create tiga produk berbeda; baca daftar/detail; update dan GET persisted; hapus produk tanpa relasi dan pastikan 404; duplicate SKU, input kosong, harga/minimum negatif, ID invalid/tidak ditemukan; perlindungan produk dengan item/tag, stok positif, serta ledger saja.
- GRN: PO unik, UUID, supplier/qty/tanggal stabil, status awal pending dan RFID menunggu; update pending, verify sekali, audit VERIFY, penolakan edit/cancel selesai; cancel GRN terpisah dengan reason; strict 409 tanpa perubahan; PO duplicate, supplier kosong, qty nol/negatif/pecahan, tanggal invalid, missing UUID, serta dampak stok.
- RFID: tiga EPC baru 24 hex, tiga tipe dengan mapping native Supabase; relasi item/tag/product/GRN; ENCODED dan hardware_confirmed false; legacy EPC QA terbaca; update tipe, reassignment sebelum transaksi; larangan edit EPC, status ilegal, reassign GRN/transaksi, dan deactivate tag bertransaksi. Fixture ENCODED dengan ledger menguji histori transaksi meskipun status tag masih bisa diedit secara umum. Deactivate capability/strict, reason, EPC tetap tersimpan dan reuse 409.
- Audit: catatan CREATE/UPDATE/VERIFY/CANCEL/ENCODE_SIMULATION/DEACTIVATE diperiksa dari detail HTTP dengan entity_type/entity_id, action, before/after dan reason. Audit produk/DELETE, zero orphan, ledger, item native dan publisher spy diperiksa terpisah melalui PostgreSQL QA.
- Safety: port Production ditolak sebelum request terkirim; server berlabel Docker tanpa attestation ditolak tanpa write; setup produk yang sengaja dibuat invalid menghentikan urutan sebelum operasi dependen PUT/PATCH/DELETE; server menolak mutation tanpa header QA.

## E. Hasil Pengujian

Setiap baris berikut berasal dari response dan assertion Newman yang dieksekusi. Expected 400/404/409 adalah hasil benar untuk negative case, bukan FAIL. Dua mode QA ditampilkan pada satu baris agar perbedaan capability terlihat.

| Test Case | Expected Result | Actual Result | Status |
|---|---|---|---|
| 01.00 — Mulai run QA | HTTP 200 | capability 200; strict 200 | PASS |
| 01.01 — CREATE produk tanpa relasi | HTTP 201 | capability 201; strict 201 | PASS |
| 01.02 — CREATE produk untuk relasi | HTTP 201 | capability 201; strict 201 | PASS |
| 01.03 — CREATE produk reassignment | HTTP 201 | capability 201; strict 201 | PASS |
| 01.04 — READ daftar produk | HTTP 200 | capability 200; strict 200 | PASS |
| 01.05 — READ detail produk | HTTP 200 | capability 200; strict 200 | PASS |
| 01.06 — UPDATE produk | HTTP 200 | capability 200; strict 200 | PASS |
| 01.07 — READ update persisted | HTTP 200 | capability 200; strict 200 | PASS |
| 01.N — SKU kosong | HTTP 400 | capability 400; strict 400 | PASS |
| 01.N — Nama kosong | HTTP 400 | capability 400; strict 400 | PASS |
| 01.N — Harga negatif | HTTP 400 | capability 400; strict 400 | PASS |
| 01.N — Minimum stok negatif | HTTP 400 | capability 400; strict 400 | PASS |
| 01.N — SKU duplikat | HTTP 409 | capability 409; strict 409 | PASS |
| 01.N — UUID tidak ditemukan | HTTP 404 | capability 404; strict 404 | PASS |
| 01.N — Format ID salah | HTTP 400 | capability 400; strict 400 | PASS |
| 01.08 — DELETE hanya produk QA tanpa relasi | HTTP 200 | capability 200; strict 200 | PASS |
| 01.09 — GET setelah DELETE | HTTP 404 | capability 404; strict 404 | PASS |
| 02.01 — CREATE GRN verifikasi | HTTP 201 | capability 201; strict 201 | PASS |
| 02.02 — CREATE GRN pembatalan terpisah | HTTP 201 | capability 201; strict 201 | PASS |
| 02.03 — READ daftar GRN | HTTP 200 | capability 200; strict 200 | PASS |
| 02.04 — READ detail GRN | HTTP 200 | capability 200; strict 200 | PASS |
| 02.05 — UPDATE pending GRN | HTTP 200 | capability 200; strict 200 | PASS |
| 02.06 — READ GRN updated | HTTP 200 | capability 200; strict 200 | PASS |
| 02.07 — VERIFY GRN | HTTP 200 | capability 200; strict 200 | PASS |
| 02.N — Verifikasi ulang | HTTP 409 | capability 409; strict 409 | PASS |
| 02.N — Edit GRN selesai | HTTP 409 | capability 409; strict 409 | PASS |
| 02.N — Cancel GRN selesai ditolak | HTTP 409 | capability 409; strict 409 | PASS |
| 02.N — Pembatalan wajib alasan | HTTP 400 | capability 400; strict 400 | PASS |
| 02.08 — CANCEL atau penolakan constraint | capability 200; strict 409 | capability 200; strict 409 | PASS |
| 02.N — Pembatalan ulang ditolak | HTTP 409 | capability 409; strict 409 | PASS |
| 02.N — GRN berdampak stok fixture QA | HTTP 409 | capability 409; strict 409 | PASS |
| 02.N — Supplier kosong | HTTP 400 | capability 400; strict 400 | PASS |
| 02.N — Qty nol | HTTP 400 | capability 400; strict 400 | PASS |
| 02.N — Qty negatif | HTTP 400 | capability 400; strict 400 | PASS |
| 02.N — Qty pecahan | HTTP 400 | capability 400; strict 400 | PASS |
| 02.N — Tanggal invalid | HTTP 400 | capability 400; strict 400 | PASS |
| 02.N — PO duplikat | HTTP 409 | capability 409; strict 409 | PASS |
| 02.N — GRN tidak ditemukan | HTTP 404 | capability 404; strict 404 | PASS |
| 03.01 — ENCODE label biasa dan item GRN | HTTP 201 | capability 201; strict 201 | PASS |
| 03.02 — ENCODE ON_METAL untuk reassignment | HTTP 201 | capability 201; strict 201 | PASS |
| 03.03 — ENCODE HARD_TAG untuk deactivate | HTTP 201 | capability 201; strict 201 | PASS |
| 03.04 — READ daftar RFID termasuk legacy QA | HTTP 200 | capability 200; strict 200 | PASS |
| 03.05 — READ detail RFID | HTTP 200 | capability 200; strict 200 | PASS |
| 03.06 — UPDATE tipe RFID | HTTP 200 | capability 200; strict 200 | PASS |
| 03.07 — REASSIGN tag tanpa transaksi | HTTP 200 | capability 200; strict 200 | PASS |
| 03.08 — READ reassignment persisted | HTTP 200 | capability 200; strict 200 | PASS |
| 03.N — EPC immutable | HTTP 409 | capability 409; strict 409 | PASS |
| 03.N — Transisi IN_STOCK ilegal | HTTP 409 | capability 409; strict 409 | PASS |
| 03.N — Reassign tag GRN ditolak | HTTP 409 | capability 409; strict 409 | PASS |
| 03.N — Reassign tag transaksi fixture QA ditolak | HTTP 409 | capability 409; strict 409 | PASS |
| 03.N — Deactivate tag transaksi ditolak | HTTP 409 | capability 409; strict 409 | PASS |
| 03.N — Reassign ENCODED dengan ledger ditolak | HTTP 409 | capability 409; strict 409 | PASS |
| 03.N — Deactivate ENCODED dengan ledger ditolak | HTTP 409 | capability 409; strict 409 | PASS |
| 03.N — Deactivate wajib alasan | HTTP 400 | capability 400; strict 400 | PASS |
| 03.09 — DEACTIVATE atau penolakan constraint | capability 200; strict 409 | capability 200; strict 409 | PASS |
| 03.N — EPC tetap tidak boleh digunakan ulang | HTTP 409 | capability 409; strict 409 | PASS |
| 03.N — EPC pendek | HTTP 400 | capability 400; strict 400 | PASS |
| 03.N — EPC lebih 96 bit | HTTP 400 | capability 400; strict 400 | PASS |
| 03.N — EPC non-hex | HTTP 400 | capability 400; strict 400 | PASS |
| 03.N — EPC duplikat | HTTP 409 | capability 409; strict 409 | PASS |
| 03.N — Produk tidak ditemukan | HTTP 404 | capability 404; strict 404 | PASS |
| 03.N — Type invalid | HTTP 400 | capability 400; strict 400 | PASS |
| 03.N — Hardware belum didukung | HTTP 409 | capability 409; strict 409 | PASS |
| 03.N — Tag tidak ditemukan | HTTP 404 | capability 404; strict 404 | PASS |
| 04.01 — Audit CREATE UPDATE VERIFY GRN | HTTP 200 | capability 200; strict 200 | PASS |
| 04.02 — Audit CANCEL dan data tidak dihapus | HTTP 200 | capability 200; strict 200 | PASS |
| 04.03 — Audit ENCODE UPDATE RFID | HTTP 200 | capability 200; strict 200 | PASS |
| 04.04 — Audit DEACTIVATE dan retensi EPC item | HTTP 200 | capability 200; strict 200 | PASS |
| 04.05 — DELETE produk berelasi ditolak | HTTP 409 | capability 409; strict 409 | PASS |
| 04.06 — READ produk berelasi tetap ada | HTTP 200 | capability 200; strict 200 | PASS |
| 04.07 — DELETE fixture stok dan ledger ditolak | HTTP 409 | capability 409; strict 409 | PASS |
| 04.08 — READ fixture stok tetap | HTTP 200 | capability 200; strict 200 | PASS |
| 04.09 — DELETE produk hanya relasi ledger ditolak | HTTP 409 | capability 409; strict 409 | PASS |
| 04.10 — READ produk ledger tanpa stok tetap ada | HTTP 200 | capability 200; strict 200 | PASS |
| 05.01 — HEALTH QA | HTTP 200 | capability 200; strict 200 | PASS |
| 05.02 — JSON malformed | HTTP 400 | capability 400; strict 400 | PASS |
| Production: HEALTH Production (bukan bukti database) | HTTP 200, GET | HTTP 200; GET | PASS |
| Production: READ daftar products | HTTP 200, GET | HTTP 200; GET | PASS |
| Production: READ detail products | HTTP 200, GET | HTTP 200; GET | PASS |
| Production: READ daftar grn | HTTP 200, GET | HTTP 200; GET | PASS |
| Production: READ detail grn | HTTP 200, GET | HTTP 200; GET | PASS |
| Production: READ daftar tags | HTTP 200, GET | HTTP 200; GET | PASS |
| Production: READ detail tags | HTTP 200, GET | HTTP 200; GET | PASS |

## F. Pengujian UUID

UUID respons create ditangkap ke environment runtime dan dibandingkan utuh pada GET/PUT/verify/edit/tag relasi. Pola UUID divalidasi; tidak ada pemetaan UUID menjadi integer. SKU/PO memakai prefix QA-O1-SKU-/QA-O1-PO- dengan ID run acak; EPC dibuat ulang untuk setiap run. ID seed Production tidak di-hardcode. Production detail mengambil UUID dari list GET pada run yang sama.

## G. Pengujian Database

34 pemeriksaan tambahan mencakup validasi schema/import, keamanan target, penghentian setup gagal, identitas cluster, serta integrasi database. Angka ini terpisah dari assertion Postman. Per mode, SQL QA membuktikan ledger identik sebelum/sesudah; fixture produk/GRN/tag/ledger tidak berubah; tidak ada orphan product/tag/GRN; relasi produk pada ledger/tag konsisten; item tetap ENCODED tanpa lokasi; reassignment tersimpan; produk yang dihapus tetap memiliki audit CREATE/UPDATE/DELETE dengan snapshot; EPC dan item setelah deactivate tetap ada. Audit berjumlah 16 pada capability dan 14 pada strict; request gagal tidak menambahkan audit. Ada tepat tiga panggilan publisher spy untuk tiga encode sukses, seluruhnya simulation/hardware_confirmed false, tanpa publish ke broker.

Tidak ada endpoint baru untuk audit. Audit produk/ledger tidak diklaim sebagai request Postman. Tidak ada klaim audit Production bertambah: suite Production tidak menulis atau menghitung seluruh audit melalui SQL. Hasil Production read-only membuktikan response HTTP/UUID/detail pada waktu run; tidak membuktikan database bebas perubahan dari proses lain.

## H. Pengujian Error Handling

HTTP 400 terbukti untuk input invalid dan JSON malformed; 404 untuk UUID yang tidak ditemukan serta GET produk setelah DELETE; 409 untuk duplikat, transisi ilegal, relasi/stock/ledger, serta status yang tidak didukung fixture strict. Error aplikasi dicek success false dan message nonkosong. Malformed JSON ditolak sebelum handler oleh Fastify dan menggunakan statusCode/error/message; bentuk native ini diuji secara eksplisit. HTTP 403 server QA dibuktikan dengan inject tanpa header attestation (pemeriksaan integrasi, bukan endpoint aplikasi tambahan).

## I. Hasil Collection Runner

Newman 6.2.3, satu iteration per mode, bail aktif. Koleksi QA memuat 76 item; Production tujuh item GET. HTTP total juga menghitung GET attestation sebelum tiap request QA; jumlah itu tidak boleh dianggap item bisnis tambahan. SDK execution entry untuk callback preflight dideduplikasi berdasarkan item ID sebelum pelaporan assertion.

| Run | Item koleksi dieksekusi | HTTP total | GET attestation tambahan | Assertion | PASS | FAIL | SKIP | Waktu collection |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| qa-capability | 76 | 152 | 76 | 376 | 376 | 0 | 0 | 7793 ms |
| qa-strict | 76 | 152 | 76 | 374 | 374 | 0 | 0 | 7796 ms |
| production-readonly | 7 | 7 | 0 | 24 | 24 | 0 | 0 | 3044 ms |

Total suite normal: **159 eksekusi item koleksi, 774 assertion PASS, 0 FAIL, 0 SKIP**. Ada 34 pemeriksaan tambahan PASS. Angka 158 PASS dari pekerjaan sebelumnya tidak dimasukkan.

Tiga fault-injection run guard sengaja menghasilkan failed assertion/script dan dihitung terpisah. File guard-production-url membuktikan target 5000 diblokir; guard-unproven-database hanya mencapai GET health server stub; guard-setup-failure berhenti sesudah setup produk 400, tanpa PUT/PATCH/DELETE selanjutnya. Assertion gagal ini merupakan stimulus untuk uji guard, bukan kegagalan suite bisnis yang disembunyikan. Validasi guard yang memeriksa efeknya tercatat PASS pada integration-checks.json.

## J. Bukti Pengujian

- evidence/qa-capability.json dan qa-strict.json: status, waktu, dan nama/hasil assertion per item; tanpa response body/headers/environment.
- evidence/production-readonly.json: tujuh GET aktual dengan assertion UUID; payload data operasional tidak disimpan.
- evidence/guard-production-url.json, guard-unproven-database.json, guard-setup-failure.json: stimulus kegagalan disengaja untuk safety.
- evidence/integration-checks.json dan summary.json: pemeriksaan SQL QA/static/safety, statistik raw Newman, waktu.
- evidence/runner-report.html: tampilan bukti aktual yang dapat dibuka di browser atau dicetak PDF, bukan screenshot Postman palsu.
- collection-schema-v2.1.json: schema resmi; kedua koleksi lolos validasi draft-04 serta konstruksi/import SDK Postman yang dipakai Newman. Import GUI Postman tidak dioperasikan pada sesi ini.

## K. Kendala dan Batasan

CRUD Production, perubahan CHECK Production, migrasi audit, putaway Orang 2, stock opname Orang 3, autentikasi/actor Orang 4, hardware RFID fisik dan pengiriman MQTT bisnis: **NOT TESTED pada tugas ini**. Cancel/DAMAGED success hanya terbukti pada capability QA; strict membuktikan penolakan aman. Tabel audit QA adalah fixture kontrak, sehingga suite ini tidak menguji deployment migrasi, RLS/privilege Supabase Production atau autentikasi aplikasi. Klaim keamanan QA adalah isolasi proses/cluster ditambah guard, bukan mekanisme autentikasi Production.

Newman dipasang sementara tanpa dependency global/proyek. Node mengeluarkan deprecation warning fs.F_OK dari toolchain Newman; tidak ada failed assertion normal akibat warning itu. Pengujian menggunakan aplikasi Fastify dan repository aktual dengan fixture schema; tidak menguji UI browser pada tugas ini. Pengukuran durasi adalah durasi collection lokal, bukan benchmark beban/performa Production. Cluster disposable dihentikan setelah run; direktori TEMP QA dapat tersisa, tidak ada database operasional yang di-cleanup.

## L. Kesimpulan

API Orang 1 siap untuk demonstrasi alur CRUD pada QA disposable dan demonstrasi tujuh endpoint GET pada backend existing berdasarkan bukti run ini. Master SKU, GRN, RFID, UUID, error handling, perlindungan relasi dan audit sesuai assertion yang dieksekusi. Gunakan README_POSTMAN_TESTING.md untuk import, pemilihan environment, urutan Runner, dan pemisahan capability/strict. Tidak diperlukan penerapan atau perubahan Production untuk memakai artefak ini.
