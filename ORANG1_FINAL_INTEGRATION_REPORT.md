# DigiWMS Orang 1 — Final Integration Review

Tanggal: 9 November 2026 (Asia/Jakarta). Kedua repository tetap pada `feat/orang1-inbound`. Status: integrasi QA lulus; demo read-only Production dan demo CRUD di QA tersedia. Write testing Production belum dilakukan dan tidak diizinkan pada tahap ini.

## A. Ringkasan Executive

Bug stok 0, mapping tipe tag Supabase, tanggal GRN yang mundur satu hari, dan default item yang berisiko langsung IN_STOCK telah diperbaiki dalam modul Orang 1. UUID dan EPC legacy dipertahankan. Registrasi meja secara eksplisit menyimpan item ENCODED, tanpa menambah ledger atau mengklaim chip fisik sudah ditulis.

Batasan penting: constraint Supabase Production saat ini hanya mengizinkan GRN `MENUNGGU_VERIFIKASI/SELESAI`, serta status tag tanpa `DAMAGED`. Karena skema Production tidak boleh diubah, cancel/deactivate ditolak 409 dengan pesan jelas bila status tersebut tidak didukung. Tidak ada sukses palsu atau perubahan audit sebagai pengganti status yang gagal disimpan. Kedua alur lulus di fixture QA yang mendukung status tersebut; fixture itu bukan perubahan yang disetujui pada Production.

## B. Temuan Awal

| Temuan | Bukti dan penanganan |
| --- | --- |
| API mengganti stok menjadi 0 | `products.current_stock` berisi angka, tetapi kode menjumlahkan `qty` dengan relasi product_id, sementara ledger Supabase memakai qty_change dan seluruh baris existing tanpa product_id. Perbaikan: pertahankan proyeksi stok existing dari produk; ledger menjadi fallback hanya pada model tanpa kolom stok. |
| Kolom tipe tag tampak kosong | Seluruh 6 tag memiliki tag_type non-NULL; backend/UI membaca type. Mapping eksplisit kini menghubungkan kode API dengan label Supabase. |
| Tanggal penerimaan mundur sehari | DATE diparse pg sebagai Date lokal, lalu diserialisasi UTC dan dipotong frontend. Query GET/RETURNING GRN kini mengeluarkan teks kalender YYYY-MM-DD. |
| Default items.status salah untuk penerimaan | Supabase memberi default IN_STOCK. Registrasi/tag assignment Orang 1 kini eksplisit ENCODED sebelum putaway. |
| State akhir tidak didukung Production | CHECK GRN belum mencakup DIBATALKAN; CHECK tags belum mencakup DAMAGED. Pemeriksaan constraint/enum sebelum perubahan menghasilkan 409 bila tidak didukung. |
| Proteksi riwayat kurang lengkap | Ledger Supabase memakai tag_id; items juga punya status transaksi. Keduanya kini diperiksa sebelum edit/deactivate. SKU dengan referensi ledger legacy tanpa UUID tidak boleh diganti. Stok tercatat positif mencegah delete produk meski relasi lain kosong. |
| verified_at belum ditulis | Verifikasi kini menyimpan timestamp jika kolom tersedia; identitas verified_by tidak dikarang. |
| Regresi form baru saat review | Akses tipe pada row yang belum ada sempat membuat form RFID kosong. Guard diperbaiki, ditambahkan test, dan alur browser diulang sampai berhasil. |
| Health menyebut POSTGRESQL_DOCKER | Label berasal dari ternary statis pada modul Orang 4; bukan deteksi sumber koneksi. Tidak diedit karena kepemilikan modul dan kontrak yang harus dijaga. |

## C. Hasil Audit Master SKU

CRUD, UUID, validasi harga/minimum, duplicate SKU, detail, serta penolakan delete berelasi lulus regresi QA. Field `unit_price/min_stock_threshold/default_location_code` disimpan sesuai kolom native Supabase; alias API lama tetap tersedia saat read. Tidak ada konversi UUID ke integer atau mapping ID baru.

Hasil SELECT Production dan GET API setelah perbaikan:

| SKU | products.current_stock / API | SUM ledger menurut UUID | SUM ledger legacy menurut SKU dengan product_id NULL | Item terkait |
| --- | ---: | ---: | ---: | ---: |
| SKU-012 | 15 | 0 | 50 | 1 |
| SKU-018 | 20 | 0 | 0 | 1 |
| SKU-024 | 18 | 0 | 0 | 1 |
| SKU-031 | 25 | 0 | 25 | 1 |
| SKU-042 | 120 | 0 | -2 | 0 |
| SKU-055 | 85 | 0 | -1 | 0 |

Tidak tepat mengganti proyeksi existing dengan angka 0 atau SUM ledger yang belum direkonsiliasi. Tidak tepat pula menyimpulkan stok fisik dari satu tag IN_STOCK. Perbaikan hanya membuat tampilan mengikuti nilai yang memang tersimpan pada sumber aplikasi, bukan mengesahkan keakuratan stok fisik. Ledger legacy tidak cukup untuk merekonstruksi saldo awal dan relasi UUID; rekonsiliasinya menjadi koordinasi Orang 2. Tidak ada perubahan current_stock, ledger, status item, atau status tag Production.

Untuk skema lokal/fallback tanpa kolom current_stock, perhitungan tetap membaca ledger dengan qty atau qty_change, memakai UUID bila tersedia dan SKU legacy hanya bila product_id memang NULL. Ini lookup ledger berdasarkan SKU unik, bukan mapping UUID menjadi integer.

## D. Hasil Audit Inbound GRN

QA lulus untuk create pending, read, update pending, verify sekali, duplicate PO, quantity/tanggal invalid, cancel dengan alasan, rollback, dan riwayat tetap tersedia. Calendar date telah diuji pada create/update/list/detail. verified_at ditulis ketika model mendukungnya; verified_by membutuhkan actor autentikasi Orang 4 dan tetap tidak dipalsukan.

Production read-only:

- Terdapat 3 GRN: dua SELESAI (150 dan 85 unit) dan satu MENUNGGU_VERIFIKASI (85 unit).
- Status RFID existing dua `Semua Ter-encode` dan satu `Menunggu Tagging` tetap berasal dari database.
- Seluruh item existing belum menaut ke grn_id pada tiga GRN tersebut. Status selesai/label encoded legacy tidak dapat dibuktikan ulang dari relasi ini; data tidak diubah agar tampak konsisten.
- Tanggal asli database adalah 2026-05-12, 2026-05-12, dan 2026-05-11; API/browser kini menampilkan hari yang sama.
- Audit kosong adalah keadaan valid setelah migrasi baru; tidak dilakukan backfill riwayat yang tidak dapat dibuktikan.

Cancel Production memerlukan review constraint dan persetujuan terpisah. Endpoint tidak menghapus GRN atau ledger. Pembatalan dengan dampak stok tetap membutuhkan reversal terotorisasi.

## E. Hasil Audit RFID

Semua 6 EPC existing berformat legacy, dan seluruhnya tetap dapat dibaca tanpa penggantian. New registration tetap mensyaratkan tepat 24 hexadecimal setelah trim/uppercase. EPC pendek lama ditolak jika dipakai sebagai input registrasi baru; tidak dihapus dari READ.

Mapping tipe eksplisit:

| Kode API | Nilai tags.tag_type Supabase |
| --- | --- |
| STANDARD_LABEL | Label Biasa (UHF) |
| ON_METAL | On-Metal (Logam/Cairan) |
| HARD_TAG | Hard Tag (Aset) |

Frontend menampilkan fallback informatif untuk NULL/nilai legacy yang tidak dikenal, tanpa memilih tipe secara acak. Form edit tidak diam-diam mengganti tipe yang tidak diketahui menjadi STANDARD_LABEL.

QA membuktikan registrasi native tag_type, UUID tag/item, item ENCODED meskipun default tabel IN_STOCK, penggantian tipe sebelum transaksi, riwayat old/new identity, pengecekan ledger.tag_id/item.status/gate, duplicate EPC, rollback tanpa orphan, dan MQTT hanya setelah commit.

Production memiliki empat tag IN_STOCK dan dua AUTHORIZED_OUT; dua tag tidak memiliki item terkait. Ini bukan FK orphan karena relasinya opsional, tetapi penautan produk tidak boleh ditebak dari suffix EPC. Data ini dipertahankan dan perlu dikaji bersama pemilik data/inventory. DAMAGED tidak didukung CHECK Production saat ini; penolakannya diuji pada QA replika constraint yang sama, sedangkan keberhasilan DAMAGED diuji hanya pada QA capability fixture.

## F. Hasil Audit PostgreSQL Supabase

Sumber koneksi existing tetap Supabase PostgreSQL 17.11 dengan role SQL postgres. Password, connection string, token, dan hostname tidak dicetak dalam laporan. PostgreSQL Docker lokal yang juga healthy adalah sumber terpisah dan tidak digunakan sebagai QA atau sumber utama API.

Audit Production hanya menggunakan SELECT/metadata, termasuk transaksi READ ONLY. Pemeriksaan membuktikan:

- UUID pada products, GRN, tags, items dan FK produk/tag/GRN pada items.
- Orphan items→products = 0; items→tags = 0; items→GRN = 0.
- public.orang1_inbound_audit dan sequence tersedia, RLS aktif, dua indeks valid/ready.
- postgres memiliki izin audit; anon/authenticated/service_role tidak memiliki privilege tabel/kolom/sequence langsung yang diperiksa.
- Total audit tetap 0; tidak ada audit dummy yang ditulis pada Production.
- Repository menggunakan public.orang1_inbound_audit secara eksplisit dan mendukung entity_id UUID sebagai teks utuh.
- GET daftar/detail untuk 6 produk, 3 GRN, dan 6 tag berhasil. Tambahan GET UUID tidak ditemukan menghasilkan 404. Total 19 pemeriksaan GET terstruktur, ditambah health.

Bukti tersanitasi disimpan di `tests/evidence/production-readonly-final.json` dan `production-readonly-after-cleanup.json`: hasil izin, indeks, stok, ringkasan GRN/tag, count/orphan, serta checksum isi tabel untuk pembandingan. Count/checksum keenam tabel yang diperiksa sama pada kedua pemeriksaan akhir, termasuk audit tetap 0. Ini pemeriksaan pada dua titik waktu, bukan klaim pemantauan semua aktivitas tim. Tidak ada payload audit atau kredensial yang disimpan. Script `tests/production-readonly-review.cjs --read-only` hanya melakukan SELECT dan HTTP GET; suite CRUD tidak menggunakan DATABASE_URL tersebut.

Migrasi audit yang sudah diterapkan manual tidak dijalankan ulang pada Production dan file SQL migrasi/verifikasinya tidak diedit dalam tahap ini. Eksekusi migrasi pada fixture PostgreSQL QA dilakukan hanya untuk menguji ulang keamanan lingkungan terisolasi.

## G. Hasil MQTT

| Lingkungan | Hasil |
| --- | --- |
| Simulator TCP lokal | PASS; helper publish, payload, commit dan penolakan operasi gagal diuji |
| EMQX Docker asli | PASS; healthy, satu publish sintetis di topik QA unik diterima observer TCP dan WebSocket |
| Proses bisnis tag → MQTT pada QA | PASS dengan publisher observer; dapat membaca row committed dan tidak menerima event saat operasi gagal |
| Event bisnis pada wms/tags/encoded broker operasional | NOT TESTED dengan write Production; tidak ada event palsu dikirim |
| Penulisan/read-back chip RFID fisik | NOT TESTED; reader/SDK belum tersedia |

Pengguna memberi izin eksplisit untuk satu publish QA. Subscription diperiksa dahulu: server mendengar gate/opname; web mendengar wms/# dan hanya merefresh data. Topik yang digunakan `wms/qa/orang1/mqtt-test/29e0f927-5e0f-428c-86dd-5adea8b50108`, payload business_event=false tanpa product_id/EPC, non-retained. Semua client QA ditutup setelah selesai. Tidak ada konfigurasi EMQX atau topik anggota lain yang diubah. Keberhasilan transport ini tidak membuktikan encoding chip fisik. Publisher existing tetap best effort saat broker offline; tidak ditambah outbox pada tahap ini.

## H. Hasil Pengujian

| Pengujian | Status | Bukti |
| --- | --- | --- |
| Backend build | PASS | tests/evidence/final-backend-build.txt |
| Frontend build | PASS | frontend tests/evidence/final-frontend-build.txt; warning ukuran bundle >500 kB tetap ada |
| Master SKU CRUD QA | PASS | final-crud.txt + final-supabase-qa.txt; native unit_price/minimum/UUID dan proteksi stok |
| GRN CRUD QA | PASS | final-crud.txt + final-supabase-qa.txt; termasuk cancel pada capability fixture |
| RFID CRUD QA | PASS | final-crud.txt + final-supabase-qa.txt; termasuk DAMAGED pada capability fixture |
| Audit Trail QA | PASS | final-audit-qa.txt; juga browser PostgreSQL QA |
| Supabase Production read-only | PASS | production-readonly-final.json; 19 GET checks + health |
| EMQX asli | PASS | final-emqx.txt; satu publish QA dengan izin |
| MQTT simulator | PASS | final-mqtt-simulator.txt |
| Startup hasil build/HTTP | PASS | final-runtime.txt; fallback disposable dengan override proses, bukan Production |
| Frontend helper/validasi | PASS | frontend tests/evidence/final-frontend-tests.txt |
| Browser Production | PASS read-only | Navigasi, daftar/detail tiga menu, UUID, pencarian/filter, refresh, loading/empty, EPC legacy, tipe tag, tanggal; screenshot final-production-readonly.jpg |
| Browser PostgreSQL QA | PASS | Create/edit SKU, create/verify/cancel GRN, create/edit/deactivate RFID, audit/reason/UUID; screenshot final-postgres-qa-audit.jpg |
| Browser kegagalan jaringan QA | PASS | Backend QA sengaja dihentikan, refresh memunculkan Failed to fetch dan peringatan data mungkin belum mutakhir |
| Browser hard delete SKU | NOT TESTED | Hapus produk tanpa relasi sudah diuji melalui API QA otomatis; tidak diklik pada Production |
| Hardware RFID | NOT TESTED | Tidak tersedia reader/SDK dan konfirmasi fisik |
| Write testing Production | NOT TESTED | Sengaja tidak dilakukan, memerlukan persetujuan terpisah |

Jumlah test runner final: 109 regresi CRUD + 20 kontrak Supabase + 15 audit + 1 startup + 1 MQTT simulator + 1 EMQX + 11 frontend = **158 PASS, 0 FAIL, 4 SKIP**. Empat SKIP hanya untuk pemeriksaan PostgreSQL pada varian memory; pemeriksaan PostgreSQL yang relevan lulus. Browser/GET checks/build dilaporkan terpisah dari hitungan test runner.

Satu error render sempat terjadi di browser QA pada proses perbaikan, lalu diperbaiki dan diuji ulang. Console setelah reload/perbaikan tidak menunjukkan error baru sebelum uji kegagalan jaringan yang disengaja. Browser Production tidak menunjukkan error/warning pada sesi yang diperiksa.

Layout layar kecil diperiksa pada viewport 390×844: lebar dokumen tetap 390 dan tabel memakai scroll internal. Ada overflow internal main sekitar 16px dan perilaku sidebar shell existing yang perlu penyempurnaan pemilik shell; tidak dilakukan refactoring global untuk menutup temuan tersebut. Layout desktop ketiga halaman tersedia.

## I. Daftar File Diubah

Perubahan pada tahap final ini (bukan seluruh perubahan kumulatif branch):

| Repository/file | Alasan |
| --- | --- |
| Backend src/modules/orang1-inbound/service.ts | Sumber stok, mapping tipe native, status guard, item ENCODED, verified_at, proteksi ledger/stock |
| Backend src/modules/orang1-inbound/repository.ts | Baca enum/CHECK dan serialisasi calendar DATE tanpa timezone shift |
| Backend src/modules/orang1-inbound/schema-contract.ts | Mapping semantik tipe tag eksplisit |
| Backend package.json | Script test Supabase QA dan EMQX opt-in |
| Backend tests/fixtures/supabase-orang1.sql | Fixture struktur native berdasarkan metadata, bukan backup/data Production |
| Backend tests/qa-supabase.ts | Guard cluster disposable dan lifecycle schema QA |
| Backend tests/supabase-contract.test.ts | 20 test kasus skema native ketat/QA capability |
| Backend tests/emqx-qa.test.ts | Uji satu publish QA hanya dengan flag izin eksplisit |
| Backend tests/serve-browser.ts | Dukungan PostgreSQL QA terpisah untuk pengujian form |
| Backend tests/production-readonly-review.cjs | Bukti SELECT/GET saja dengan opt-in --read-only |
| Backend tests/evidence/final-*.txt + production-readonly-*.json | Log build/test dan bukti read-only tersanitasi |
| Backend ORANG1_FINAL_INTEGRATION_REPORT.md | Laporan ini dan rencana Production terkontrol |
| Frontend src/modules/orang1-inbound/api.js | Normalisasi tipe tag legacy dan guard metadata form baru |
| Frontend src/modules/orang1-inbound/InboundTaggingPage.jsx | Mapping/fallback tipe, pilihan tipe eksplisit, audit kosong, verified_at, label stok, guard form |
| Frontend tests/orang1-api.test.mjs | Regresi mapping legacy dan form tanpa row |
| Frontend tests/evidence/final-*.txt dan final-*.jpg | Log build/test dan screenshot browser |

Hash 13 file backend terlindungi dibandingkan sebelum/sesudah: tidak berubah. Ini mencakup .env, ketiadaan .env.example existing, Docker Compose, db/mqtt config, server, tsconfig, init_schema, kedua SQL migrasi/verifikasi audit, serta file implementasi Orang 2/3/4. Tidak ada commit, push, merge, reset, atau git clean. Perubahan lokal sebelum tahap ini dipertahankan; git status tidak diklaim bersih.

Backend/frontend QA dihentikan, dua schema browser QA dibersihkan, dan cluster PostgreSQL sementara dihentikan. Container EMQX serta PostgreSQL Docker existing tetap healthy; frontend/backend existing 3000/5000 tidak dihentikan.

## J. Masalah yang Belum Selesai

**Dalam lingkup Orang 1 / memerlukan persetujuan skema:** dukungan DIBATALKAN dan DAMAGED pada Production masih dibatasi CHECK. Kode tidak mengubah constraint. Diperlukan review migrasi additive terpisah, dampak lintas modul, dan persetujuan sebelum tindakan tersebut bisa berhasil di Production. Penulisan CRUD pada database Production belum dibuktikan dengan eksekusi; hasil QA tidak dinyatakan sebagai PASS write Production.

**Koordinasi Orang 2/pemilik data:** ledger existing tanpa product_id dan saldo/relasi yang tidak cukup untuk rekonstruksi; dua tag AUTHORIZED_OUT tanpa item; GRN selesai tanpa link item. Jangan menambal dengan mapping otomatis, ledger baru, atau penggantian EPC. Putaway perlu menjaga transisi dan tidak menerima tag DAMAGED/GRN batal setelah kemampuan itu disetujui.

**Koordinasi Orang 4:** label health POSTGRESQL_DOCKER statis, KPI GRN perlu memperhitungkan pembatalan saat statusnya tersedia, actor binding verified_by/audit memerlukan autentikasi, dan shell mobile memiliki overflow/sidebar yang dapat diperbaiki terpisah. File modul Orang 4 tidak diedit untuk menjaga batas kepemilikan. Label health tidak menjadi bukti sumber database.

**Perangkat:** encoding fisik, verifikasi read-back, dan kebutuhan durable MQTT outbox belum diimplementasikan; bukan bagian yang dapat dibuktikan oleh simulator atau transport EMQX.

## K. Langkah Berikutnya — Rencana Write Testing Production untuk Persetujuan Terpisah

1. Setujui lebih dahulu batas operasi, jendela waktu, actor, dampak subscriber bisnis MQTT, dan review constraint DIBATALKAN/DAMAGED bersama pemilik modul. Jangan menjalankan ulang migrasi audit 001.
2. Tentukan marker eksklusif `QA-O1-<tanggal>-<ID>` untuk SKU/PO supplier sintetis, dua SKU (satu tanpa relasi untuk delete, satu untuk relasi tag), dua GRN kecil, serta EPC random 96-bit yang diperiksa keunikannya. Jangan memakai/mengubah SKU/PO/tag seed existing.
3. Ambil snapshot read-only count/checksum dan bukti audit kosong/awal. Pastikan tidak ada putaway, picking, gate/outbound otomatis atas fixture QA. Event wms/tags/encoded pada test ini adalah dampak bisnis tersendiri yang harus disetujui; uji transport QA yang sudah lulus tidak memberi izin untuk event tersebut.
4. Setelah izin tertulis terpisah: melalui API/UI yang sama, lakukan create/read/update produk QA, delete hanya produk QA tanpa relasi, create/update/verify GRN QA, registrasi/edit tag QA, dan periksa audit melalui GET. Tidak ada SQL DML langsung atau perbaikan ledger.
5. Cancel dan deactivate baru diuji setelah constraint pendukung disetujui dan diterapkan terpisah. Jika belum, expected adalah 409 yang jelas, tanpa perubahan state/audit; jangan mengklaim fitur Production tersebut lulus.
6. Verifikasi UUID dan relasi, alasan/timestamp audit, tidak ada event saat gagal, serta seed/ledger existing tetap sama. Jika ada kegagalan, berhenti dan pertahankan bukti; jangan mengubah stok atau menghapus audit untuk merapikan hasil.
7. Pertahankan GRN/tag/audit QA sebagai riwayat bertanda QA. Tidak ada reset sequence, hard delete tag/GRN, pembersihan cascade, atau reversal stok otomatis. Ajukan prosedur cleanup tersendiri jika dibutuhkan.

Rencana ini belum dieksekusi. Tidak ada permintaan izin implisit untuk menulis Production pada tahap final review ini.

## L. Kesimpulan

Implementasi Orang 1 beserta perbaikan integrasinya sudah tersedia dan lulus QA terisolasi. Supabase Production telah diverifikasi read-only; tampilan stok, tipe tag, tanggal, UUID, dan legacy reads kini sesuai sumber yang diperiksa. Tidak ada migrasi ulang atau operasi tulis Production dari pengujian ini. Audit tetap 0 dan tidak ada orphan relasi item yang terdeteksi.

Modul siap untuk demo read-only Production serta demo CRUD lengkap pada PostgreSQL QA. Belum siap diklaim sebagai demo seluruh write workflow Production: CHECK cancel/DAMAGED, koordinasi inventory/auth, dan pengujian Production dengan fixture khusus masih memerlukan persetujuan terpisah. Encoding fisik RFID tetap NOT TESTED.
