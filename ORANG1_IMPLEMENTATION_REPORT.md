# Laporan Implementasi Orang 1 — DigiWMS

Tanggal pengujian: 5 November 2026 (Asia/Jakarta).

## 1. Ringkasan audit

Kedua repository tetap pada branch `feat/orang1-inbound`. Workspace induk bukan repository Git. Frontend awal bersih. Backend sudah memiliki perubahan lokal sebelum pekerjaan: `.env.example` terhapus; `docker-compose.yml`, `src/config/db.ts`, `src/config/mqtt.ts`, `src/server.ts`, dan `tsconfig.json` berubah. Perubahan tersebut dipertahankan, tidak ditimpa.

Kode database dan seed lokal memakai ID produk integer, `price`, serta `min_stock_alert`. Sumber UUID pada contoh belum dapat dibuktikan: API existing di port 5000/3000 tidak merespons dan Docker Desktop Linux daemon tidak tersedia. Pengujian dilakukan pada lingkungan QA terisolasi, bukan database existing atau Supabase.

## 2. Bug awal dan perbaikan

- Frontend mengakses `/api/rfid/tags` dan `/api/rfid/encode`, sementara backend menyediakan `/api/tags` dan `/api/tags/encode`.
- GRN ditampilkan dari array statis; frontend mengirim `qty`, backend membaca `total_qty`.
- Backend dan frontend langsung menyatakan GRN selesai serta semua tag encoded tanpa verifikasi.
- Form produk memakai `price_idr`/`min_stock`, backend hanya membaca `price`/`min_stock_alert`.
- Backend menghasilkan EPC pendek bertanda hubung, bukan hexadecimal 96-bit.
- `Number(product_id)` merusak UUID; fallback menerima produk tidak ditemukan dan membuat nama/SKU palsu.
- Insert tag dan item tidak atomik, berisiko orphan record; duplikat dan transisi belum divalidasi.
- Detail, update, safe delete produk, pembatalan GRN, dan penonaktifan tag belum tersedia.
- Frontend tidak konsisten menangani kegagalan, loading, empty state, atau pengiriman ganda.
- Hasil build ESM dari perubahan lokal `tsconfig.json` tidak dapat dijalankan oleh `npm start`. Script build kini mengeluarkan CommonJS menggunakan opsi CLI; file konfigurasi lokal tetap dipertahankan.
- Pemeriksaan browser menemukan label select yang ambigu. Select produk, tipe tag, dan GRN diberi nama aksesibilitas eksplisit dan diuji ulang.

## 3. File backend yang diubah/ditambahkan

| File | Peran |
| --- | --- |
| `src/modules/orang1-inbound/routes.ts` | 16 endpoint, HTTP status, error envelope, dependency injection khusus test |
| `src/modules/orang1-inbound/service.ts` | Aturan produk, GRN, tag, relasi, status, dan MQTT setelah commit |
| `src/modules/orang1-inbound/repository.ts` | PostgreSQL transactional repository dan fallback memory dengan rollback |
| `src/modules/orang1-inbound/validation.ts` | ID opaque, input produk, tanggal, jumlah, tipe tag, EPC 96-bit |
| `sql/migrations/001_orang1_inbound_audit.sql` | Tabel audit Orang 1 tambahan, tanpa mengubah PK/FK/enum |
| `tests/orang1.test.ts` | Suite kontrak CRUD di empat kombinasi backend/tipe ID |
| `tests/start-built.test.mjs` | Startup hasil build dan HTTP nyata dengan fallback disposable |
| `tests/mqtt-transport.test.ts` | Helper MQTT existing melalui paket TCP ke simulator lokal |
| `tests/serve-browser.ts` | API disposable untuk QA React, tanpa database existing |
| `package.json` | Perbaikan target build dan script test, tanpa dependency baru |
| `ORANG1_IMPLEMENTATION_REPORT.md` | Laporan dan panduan validasi |

## 4. File frontend yang diubah/ditambahkan

| File | Peran |
| --- | --- |
| `src/modules/orang1-inbound/InboundTaggingPage.jsx` | Tiga menu existing, form tambah/edit, detail, konfirmasi, filter, pencarian, loading/error/empty state |
| `src/modules/orang1-inbound/api.js` | Pemeriksaan HTTP dan `success`, normalisasi field form, ID produk asli, generator EPC |
| `tests/orang1-api.test.mjs` | Delapan pengujian helper API dan identitas |
| `tests/evidence/rfid-browser-qa.jpg` | Bukti browser: UUID, tag DAMAGED, alasan dan riwayat |
| `package.json` | Script `test:orang1`, tanpa dependency baru |

Shell aplikasi, navigasi, warna, tabel, dan gaya modal tetap mengikuti DigiWMS. Tidak ada file implementasi Orang 2/3/4 atau konfigurasi global frontend yang diubah.

## 5. Endpoint

| Metode | Path | Perilaku |
| --- | --- | --- |
| GET | `/api/products` | Daftar, alias field harga/minimum, stok dari ledger |
| GET | `/api/products/:id` | Detail identitas asli |
| POST | `/api/products` | Tambah SKU tervalidasi |
| PUT | `/api/products/:id` | Update tanpa mengganti ID |
| DELETE | `/api/products/:id` | Hanya produk tanpa relasi |
| GET | `/api/inbound/grn` | Riwayat dari backend |
| GET | `/api/inbound/grn/:id` | Detail dan riwayat audit |
| POST | `/api/inbound/grn` | Pending verifikasi dan tagging |
| PUT | `/api/inbound/grn/:id` | Hanya pending dan tanpa relasi transaksi |
| PATCH | `/api/inbound/grn/:id/verify` | Pending menjadi SELESAI; tidak mengubah RFID menjadi selesai |
| PATCH | `/api/inbound/grn/:id/cancel` | DIBATALKAN, alasan wajib, riwayat dipertahankan |
| GET | `/api/tags` | EPC, tipe/status, produk, lokasi/rack_name existing |
| GET | `/api/tags/:id` | Detail dan riwayat audit |
| POST | `/api/tags/encode` | Registrasi simulasi EPC dan item secara atomik |
| PATCH | `/api/tags/:id` | Koreksi aman; UNASSIGNED → ENCODED membutuhkan produk |
| PATCH | `/api/tags/:id/deactivate` | DAMAGED dengan alasan, tidak hard delete |

Sukses memakai `{ success, message, data }`. POST encode tetap menyediakan `tag` dan `item` di tingkat atas agar kontrak lama tidak terputus. Harga/minimum menerima field existing serta alias `unit_price`/`min_stock_threshold` dan `price_idr`/`min_stock` dari quick-add existing. Angka pada request harus JSON number. Lokasi default hanya disimpan bila kolom tersedia; nilai nonkosong ditolak dengan jelas bila skema tidak mendukung.

## 6. Hasil CRUD Master SKU

Semua PASS berikut diuji melalui Fastify injection terhadap memory integer, memory UUID, PostgreSQL integer, dan PostgreSQL UUID terisolasi.

| Pengujian | Hasil |
| --- | --- |
| Create produk valid, read daftar/detail, update ID tetap | PASS |
| Delete produk tanpa relasi, kemudian detail 404 | PASS |
| Tolak delete produk dengan item/tag/ledger | PASS |
| Tolak SKU duplikat | PASS |
| Tolak harga/minimum negatif, pecahan minimum, null, string angka, field wajib kosong | PASS |
| Tolak ID tidak ditemukan/format tidak valid | PASS |
| Simpan harga/minimum dari alias quick-add | PASS |
| Field native unit_price/min_stock_threshold dan lokasi default pada skema pendukung | PASS — PostgreSQL QA |

## 7. Hasil CRUD Inbound GRN

| Pengujian | Hasil |
| --- | --- |
| Create pending, read daftar/detail, edit sebelum verifikasi | PASS |
| Verifikasi sekali; RFID tetap menunggu tagging | PASS |
| Tolak edit/verifikasi ulang/pembatalan sederhana setelah selesai | PASS |
| Batalkan pending tanpa relasi; alasan dan row tetap tersimpan | PASS |
| Tolak pembatalan berulang atau tanpa alasan | PASS |
| Tolak pembatalan/edit bila ada dampak stok; ledger tidak berubah | PASS |
| Tolak PO duplikat, jumlah nol/negatif/pecahan, tanggal invalid/null/tahun 0000 | PASS |
| Tolak status selesai/auto-encoded yang dipaksakan saat create | PASS |
| GRN memiliki item: pembatalan/edit ditolak; batas jumlah unit tagging ditegakkan | PASS |

Skema existing tidak memiliki `goods_receipts.product_id`. Hubungan produk–GRN disimpan melalui `items.product_id` dan `items.grn_id` ketika registrasi tag. Request yang memaksakan produk langsung pada GRN ditolak secara eksplisit, bukan diabaikan. Status RFID tidak diklaim selesai otomatis oleh mode simulasi.

## 8. Hasil CRUD RFID Tagging

| Pengujian | Hasil |
| --- | --- |
| Registrasi EPC valid, normalisasi uppercase, read daftar/detail | PASS |
| Generator menghasilkan 24 karakter hexadecimal | PASS |
| Koreksi tipe dan produk sebelum transaksi; audit old/new product benar | PASS |
| Tolak perubahan EPC, duplikat, format pendek/nonhex, tipe invalid, produk tidak ditemukan | PASS |
| Penonaktifan DAMAGED menyimpan alasan, item dan EPC tetap ada | PASS |
| Tolak penggunaan ulang EPC DAMAGED | PASS |
| Tolak transisi IN_STOCK/RESERVED/DAMAGED melalui endpoint edit | PASS |
| UNASSIGNED → ENCODED wajib memiliki produk | PASS |
| Tolak penonaktifan/reassignment dengan lokasi/ledger/gate/status akhir | PASS |
| Dua request EPC bersamaan menghasilkan satu tag/item/event | PASS |
| Kegagalan insert item me-rollback tag; tidak ada orphan atau MQTT palsu | PASS |
| `rack_name` API existing tetap tersedia dari relasi lokasi | PASS |
| Encoding chip fisik dan read-back reader | NOT TESTED — perangkat/SDK belum diketahui |

## 9. UUID

Frontend memilih dan mengirim `product.id` asli. Backend membandingkan ID sebagai opaque identity, lalu menggunakan ID row produk yang benar-benar ditemukan saat mengisi foreign key. Tidak ada pemetaan berdasarkan indeks/urutan array, dan tidak ada cast UUID menjadi integer.

PostgreSQL memakai lookup `id::text = $1`, sehingga native UUID dan integer dapat ditangani tanpa migrasi PK. Pada fallback, UUID existing dipertahankan; generator identitas mengikuti sumber, termasuk setelah semua produk UUID dihapus dalam test disposable. Seed integer existing tidak diganti menjadi UUID baru.

UUID eksternal yang tidak ada di sumber aktif mendapat 404 dengan penjelasan bahwa pemetaannya belum terverifikasi. Kesamaan SKU saja tidak dianggap bukti pemetaan UUID eksternal. Registry pemetaan baru tidak dibuat karena sumber otoritatif belum tersedia.

## 10. PostgreSQL

PASS untuk CRUD dan integritas di PostgreSQL 16 sementara pada loopback port 55432. Dua skema QA dibuat dengan nama acak `orang1_test_*`: integer sesuai DDL existing dan UUID native sebagai fixture kompatibilitas. Skema QA mengambil DDL tabel relevan dari `sql/init_schema.sql`; tidak menjalankan seed existing atau migrasi PK pada database proyek. Skema QA dihapus setelah test. Tidak ada database existing yang dihapus, di-reset, atau dimigrasikan.

Operasi tulis memakai satu koneksi transaction, parameterized values, COMMIT/ROLLBACK, serta critical section dengan table locks agar pemeriksaan riwayat tetap aman terhadap writer putaway legacy. Ledger hanya dibaca. Lock timeout lima detik menghasilkan 409 yang dapat dicoba ulang. Tradeoff: penulisan dapat mengantre; optimasi locking dan pagination perlu dipertimbangkan bila volume meningkat.

NOT TESTED: integrasi ulang dengan PostgreSQL Docker existing dan database Supabase. Docker daemon tidak tersedia pada saat audit; sumber API UUID existing belum dapat diakses.

## 11. MQTT

PASS: helper `publishRealtimeEvent` existing benar-benar mengirim paket MQTT TCP QoS 1 ke simulator protokol lokal, dengan topik `wms/tags/encoded`, UUID asli, timestamp, `mode: simulation`, dan `hardware_confirmed: false`. Request gagal tidak menghasilkan publish. Observer PostgreSQL terpisah dapat membaca tag/item pada saat publish dipanggil, membuktikan penyimpanan sudah committed. Kegagalan publisher tidak membatalkan data yang sudah tersimpan.

NOT TESTED: EMQX existing, WebSocket EMQX, reader fisik. Simulator TCP bukan bukti EMQX aktif. Publish existing bersifat best effort dan tidak memiliki durable outbox/retry; event saat broker offline tidak dijamin dikirim ulang.

## 12. Build dan runtime

| Pemeriksaan akhir | Hasil |
| --- | --- |
| Backend `npm run build` | PASS |
| Startup `dist/server.js` dengan HTTP health/produk/GRN/encode nyata dalam proses QA | PASS |
| Frontend `npm run build` | PASS |
| Frontend warning bundle >500 kB | Ada warning, build tetap berhasil; tidak mengubah bundling global tim |
| `git diff --check` | PASS; Git hanya memberi pemberitahuan normalisasi LF/CRLF |

## 13. Automated testing

| Suite final | PASS | FAIL | SKIP |
| --- | ---: | ---: | ---: |
| CRUD `tests/orang1.test.ts` | 109 | 0 | 4 |
| Startup hasil build `tests/start-built.test.mjs` | 1 | 0 | 0 |
| Transport MQTT `tests/mqtt-transport.test.ts` | 1 | 0 | 0 |
| Frontend `tests/orang1-api.test.mjs` | 8 | 0 | 0 |
| Total | 119 | 0 | 4 |

Empat SKIP adalah dua pemeriksaan khusus PostgreSQL pada masing-masing varian memory. Pemeriksaan yang sama PASS pada kedua varian PostgreSQL. Angka ini tidak memasukkan observasi browser sebagai automated test runner.

Jalankan dari masing-masing repository:

```powershell
# Backend, default: memory tests; PostgreSQL suites skipped bila URL QA tidak disediakan.
npm run test:orang1
npm run build
npm run test:orang1:runtime
npm run test:orang1:mqtt

# PostgreSQL QA: hanya arahkan ke database test lokal disposable, bukan database proyek.
$env:ORANG1_TEST_DATABASE_URL = 'postgresql://TEST_USER@127.0.0.1:TEST_PORT/TEST_DATABASE'
$env:ORANG1_TEST_ISOLATED = '1'
npm run test:orang1
```

```powershell
# Frontend
npm run test:orang1
npm run build
```

Suite PostgreSQL membuat/menghapus skema QA sendiri. URL QA tidak diambil dari `.env` proyek. Gunakan Node 20+; pengujian ini dijalankan dengan Node 24.15.0.

## 14. Browser

PASS melalui browser pada frontend QA port 3001 dan API QA disposable port 5001: tambah/edit produk, pencarian SKU, detail UUID, empty state, create/verifikasi GRN, detail dan audit verifikasi, registrasi tag ON_METAL dengan produk UUID dan GRN, filter tipe/status, pesan EPC duplikat, detail tag, DAMAGED beserta alasan/riwayat, serta pemeriksaan layout layar kecil. Console yang diperiksa tidak menunjukkan error/warning UI. Bukti ada di frontend `tests/evidence/rfid-browser-qa.jpg`.

Browser memakai fallback memory QA dan publisher spy. Backend PostgreSQL dan transport MQTT diuji terpisah oleh suite di atas. NOT TESTED di browser: hard delete produk, pembatalan GRN, seluruh kombinasi input negatif, PostgreSQL Docker existing, MQTT WebSocket/EMQX, dan hardware reader. Hard delete/pembatalan dan input negatif sudah diuji pada API otomatis. Fallback memory bersifat sementara dan hilang saat proses dihentikan.

Reproduksi browser QA: jalankan `node --import tsx tests/serve-browser.ts` di backend. Di shell frontend, set `$env:VITE_API_URL='http://127.0.0.1:5001/api'`, lalu `npm run dev -- --port 3001 --host 127.0.0.1 --strictPort`. Ini hanya override proses QA, bukan perubahan `.env` atau port permanen.

## 15. Keamanan data dan audit trail

GRN dan tag tidak memiliki endpoint hard delete. Pembatalan hanya untuk pending tanpa relasi; setelah selesai/berdampak pada stok harus melalui reversal terotorisasi. Tag rusak tetap memiliki EPC/item dan tidak dapat diregistrasikan ulang. Tidak ada cascade baru, perubahan enum, perubahan stock movement ledger, atau migrasi primary key.

Migrasi `sql/migrations/001_orang1_inbound_audit.sql` BELUM dijalankan pada database existing. Setelah review/backup, terapkan file tersebut secara manual pada sumber database yang benar. Migrasi hanya menambah tabel/index audit Orang 1. Verifikasi GRN, pembatalan GRN, edit tag, dan penonaktifan tag di PostgreSQL ditolak 409 bila penyimpanan audit belum tersedia; perubahan di-rollback. Create produk/GRN/tag tetap dapat berjalan pada skema lama, tetapi audit detail create baru persisten bila tabel audit sudah diterapkan.

Audit menyimpan entity ID sebagai teks, before/after data, aksi, alasan, dan waktu. Pengaitan actor ke autentikasi Orang 4 belum diimplementasikan; identitas operator tidak dikarang dari input bebas. Fallback menyimpan audit di memory proses, bukan di disk.

`.env`, `.env.example`, Docker Compose, kredensial, konfigurasi broker, seed SQL, dan modul Orang 2/3/4 tidak diedit oleh pekerjaan ini. Tidak ada commit, push, merge, rebase, reset, atau instalasi dependency baru.

## 16. Dependensi integrasi tim

- Orang 2 tetap mengelola IN_STOCK dan ledger. Route putaway existing masih perlu menolak DAMAGED/GRN dibatalkan serta menjaga transisi status; modul Orang 1 tidak mengubah implementasinya. Writer legacy bisa mengantre akibat critical section transaksi Orang 1.
- Orang 2/3 masih memiliki asumsi ID numeric pada beberapa jalur fallback. Native UUID pada modul Orang 1 telah diuji, tetapi migrasi kontrak lintas modul memerlukan koordinasi; seed integer existing tetap dipertahankan.
- Orang 4 perlu mempertimbangkan status DIBATALKAN dalam agregasi GRN. Dashboard existing masih menjumlahkan semua `goods_receipts.total_qty`; perhitungannya tidak diubah di sini.
- Orang 4 mengelola authentication/RBAC dan audit pusat; audit baru Orang 1 terpisah agar implementasi tim lain tidak diubah. Actor binding dan otorisasi reversal merupakan dependensi lanjutan.
- Endpoint existing, topik MQTT, field legacy encode, dan rack_name dipertahankan. Tidak ada alias `/api/rfid/*` baru; frontend Orang 1 sudah memakai route canonical.

## 17. Pekerjaan lanjutan

1. Aktifkan kembali Docker existing, identifikasi sumber API UUID/Supabase yang otoritatif, lalu verifikasi kontrak terhadap data nyata secara read-only terlebih dahulu.
2. Review dan terapkan migrasi audit additive secara manual pada database yang benar sebelum memakai aksi berstatus/audit yang dilindungi.
3. Uji integrasi akhir frontend–PostgreSQL existing–EMQX WebSocket dengan data QA yang disepakati tim.
4. Koordinasikan validasi putaway, KPI pembatalan, identitas UUID lintas modul, actor audit, dan prosedur reversal dengan pemilik modul.
5. Integrasikan SDK reader, physical encode/read-back confirmation, serta status RFID terkonfirmasi setelah model perangkat diketahui.
6. Bila perlu jaminan pengiriman event, rancang durable MQTT outbox bersama tim tanpa mengubah ledger.

Proses QA sementara dan PostgreSQL sementara dihentikan setelah verifikasi akhir. Tidak ada migrasi otomatis terhadap database existing.
