# Laporan penyempurnaan Picking & Packing Orang 1

25 November 2026 · DIGI WMS MVP 2

## A. Ringkasan audit

Kedua checkout berada di `main` dengan working tree bersih pada awal pekerjaan. Masing-masing tertinggal tiga commit dari `origin/main` yang tercatat lokal. Perubahan mengikuti versi lokal yang sesuai dengan tangkapan layar. Commit acuan remote sudah menyentuh read model Picking, handoff Outbound, dan tampilan frontend.

Alur awal menyediakan tiga kolom Kanban, rekomendasi rak, input EPC manual, reservasi dengan lock baris, histori scan, dan checklist Packing dengan revisi dan audit. Pembuatan order belum mengecek stok sebelum menyimpan. Pengambilan EPC bergantung pada input manual dan order yang kekurangan barang belum memiliki indikator selisih. Tampilan checklist Pengiriman Orang 2 menjadi acuan untuk daftar EPC di modal Picking.

Blueprint MVP 2 menugaskan Orang 1 untuk daftar pesanan per rak, validasi EPC, reservasi, Kanban, checklist dan persiapan handoff. Orang 2 menangani Pengiriman dan ledger, Orang 3 menangani POS dan retur, dan Orang 4 menangani Gate Pass serta dashboard. Penanganan kekurangan dan pembatalan adalah penyempurnaan dari permintaan ini. Alur MVP 1 yang memasok stok Picking adalah GRN, verifikasi, Tag & Encoding, dan Putaway ke rak.

## B. Daftar file yang diubah

| Repo | File | Perubahan dan alasan |
| --- | --- | --- |
| Backend | `src/modules/orang1-picking/contract.ts` | Validasi UUID dan kuantitas untuk pembuatan order, normalisasi kebutuhan per produk, format EPC yang dipakai bersama, dan penanda penolakan scan per EPC. |
| Backend | `src/modules/orang1-picking/repository.ts` | Sumber kelayakan stok untuk hitung stok, daftar kandidat dan Kanban. Validasi stok dan penulisan order dalam satu transaksi. Progres menghitung reservasi aktif dan riwayat menyimpan semua scan. |
| Backend | `src/modules/orang1-picking/routes.ts` | Menambahkan dua GET dengan sesi gudang existing, memindahkan transaksi pembuatan order ke repository, serta memberi kode yang membedakan penolakan scan per EPC dari kegagalan transaksi. |
| Backend | `tests/picking/availability.test.ts` | Menguji kontrak dan RBAC lewat Fastify inject serta urutan query transaksi melalui Pool mock. |
| Backend | `tests/picking/http.test.ts` | Menyesuaikan skenario browser QA agar memilih EPC dari checklist. |
| Backend | `sql/proposals/006_orang1_picking_cancellation.sql` | Rancangan CHECK status dan audit ketika pembatalan disetujui. Disimpan di direktori proposal. |
| Backend | `ORANG1_MVP2_PICKING_API.md` | Memperbarui field, endpoint, dan perilaku kegagalan. |
| Backend | `ORANG1_MVP2_PICKING_ENHANCEMENT_REPORT.md` | Mencatat audit, hasil verifikasi, panduan manual dan prasyarat pembatalan. |
| Frontend | `src/modules/orang1-picking/PickingPackingPage.jsx` | Menambahkan checklist dan hasil validasi pada modal existing, ketersediaan di form buat order, serta indikator kekurangan per SKU di Kanban. |
| Frontend | `src/modules/orang1-picking/api.js` | Menjalankan scan berurutan dan mempertahankan kode galat agar batch dapat berhenti atau melanjutkan dengan benar. |
| Frontend | `tests/picking-api.test.mjs` | Menguji Bearer, pembacaan segar, urutan request, hasil parsial dan penghentian batch. |
| Frontend | `tests/picking-ui.test.mjs` | Menguji alur Picking hingga Packing melalui build frontend dan Chrome, dengan seluruh API dan WebSocket dicegat. |

## C. Pemilihan EPC dan validasi beberapa unit

`GET /api/picking/orders/:orderId/available-epcs` mengembalikan kandidat berdasarkan UUID produk dan SKU pada baris order. Kandidat memiliki relasi item–tag yang sah, EPC yang diterima validator scan, kedua status `IN_STOCK`, lokasi bertipe `RACK`, dan bebas reservasi aktif. Item atau tag yang pernah dipakai order yang sama dikecualikan. Keunikan EPC dan relasi item–tag terverifikasi dari constraint Supabase. Kandidat diurutkan menurut kode rak dan EPC, lalu dibatasi ke sisa kebutuhan per SKU.

Pada **Mulai Picking** dan **Lanjut Picking**, daftar menampilkan EPC lengkap, status, SKU dan rak dalam area yang dapat digulir. Checkbox, **Pilih Semua**, dan **Bersihkan** mengubah pilihan sementara. **Validasi Scan (N EPC)** memakai endpoint `POST /api/picking/scan` secara berurutan dan menampilkan progres batch. Modal menggunakan checklist sebagai satu-satunya cara memilih EPC. Pilihan checklist berasal dari data sistem dan diberi label simulasi.

Penolakan spesifik terhadap satu EPC ditampilkan dengan alasannya dan batch dapat meneruskan kandidat lain. Kegagalan autentikasi, database, jaringan, respons yang tidak dapat dibaca, atau konflik order menghentikan batch. UI menampilkan jumlah yang berhasil, yang ditolak, EPC yang menghentikan batch, serta jumlah yang belum diproses. UI membaca ulang Kanban, kandidat, progres dan histori. Jika pembacaan ulang order gagal, validasi berikutnya ditahan sampai pembacaan berhasil. Sistem memakai lock order, tag, item dan baris SKU yang sudah ada pada scan, dengan indeks unik reservasi aktif untuk item dan tag.

## D. Validasi stok saat membuat order

`GET /api/picking/availability?product_id=<UUID>` menggunakan aturan kelayakan yang sama dengan kandidat. Form menampilkan stok saat memilih SKU. Simpan ditahan saat stok masih diperiksa atau gagal dimuat, jumlah tidak bulat positif, atau permintaan melampaui stok. **Gunakan jumlah tersedia** menyesuaikan kuantitas setelah ditekan. Respons SKU lama diabaikan saat pilihan berubah.

`POST /api/picking/orders` menghitung ulang ketersediaan dan total kuantitas untuk setiap UUID produk, termasuk jika payload mengulang UUID yang sama. Kuantitas dikirim sebagai angka JSON bulat positif. Stok kurang mendapat HTTP 409 sebelum header maupun baris disimpan. Kegagalan penulisan me-rollback transaksi, dan UI memuat ulang stok setelah penolakan. Dua order yang belum melakukan Picking dapat memakai snapshot stok yang sama. Reservasi dimulai ketika scan berhasil.

## E. Kekurangan stok dan Lanjut Picking

Sisa kebutuhan per SKU adalah `max(0, requested_qty - picked_qty)`. Kekurangan per SKU adalah `max(0, remaining_qty - available_qty)` untuk order aktif. Jumlah tersedia mencakup seluruh EPC yang layak. Daftar checkbox hanya menampilkan maksimal sebanyak sisa kebutuhan. Informasi kekurangan muncul dari satu request daftar Kanban yang menghitung stok per rak dan menyesuaikannya dengan histori order.

Modal menampilkan sisa kebutuhan, stok tersedia, jumlah EPC yang ditampilkan dan pesan apabila rak kosong. Progres dan histori tersimpan ketika order menunggu barang. **Lanjut Picking** dan **Muat Ulang Stok** membaca ketersediaan terbaru setelah Putaway. Order baru bisa ke Packing setelah seluruh SKU terpenuhi dan reservasinya memenuhi aturan Packing existing.

## F. Pembatalan dan pelepasan reservasi

**BLOCKED.** Endpoint pembatalan, modal, filter riwayat, perubahan status dan pelepasan reservasi belum diimplementasikan. Bukti penghalang berikut berlaku pada checkout yang diaudit.

| Modul | Temuan |
| --- | --- |
| Orang 2 | `POST /api/outbound/shipments` mengunci tag dan item, lalu menerima pasangan berstatus `RESERVED` atau `IN_STOCK` tanpa membuktikan kepemilikan order Orang 1 dan penyelesaian Packing. `GET /api/outbound/picking-orders` mengambil semua order Orang 1 dan perlu mengecualikan `DIBATALKAN` sebelum status itu diaktifkan. `POST /api/outbound/authorize` membaca kesiapan dari tabel Picking Outbound sendiri saat mengotorisasi barang `RESERVED`. Lihat [rute Outbound](src/modules/orang2-inventory/outbound.routes.ts). |
| Orang 3 | Checkout POS mengunci tag dan item serta mensyaratkan keduanya `IN_STOCK` pada rak. Checkout belum memeriksa reservasi aktif Orang 1 untuk keadaan status yang menyimpang. Jejak transaksi per tag tercatat di `stock_movements` dan nomor dokumennya perlu direkonsiliasi dengan `sales` serta retur. Lihat [rute POS](src/modules/orang3-opname/pos.routes.ts). |
| Orang 4 | `POST /api/gate-passes/generate` menyimpan pass dan memperbarui tag di query terpisah. Update tag tidak mengecek status sebelumnya atau kepemilikan reservasi Picking. Skema `gate_passes` juga tidak menyimpan relasi per EPC. `gate_events` merekam kejadian saat barang diproses di gerbang, sehingga ketiadaan event belum membuktikan ketiadaan pass. Lihat [rute Gate Pass](src/modules/orang4-dashboard/routes.ts). |

Kontrak yang diusulkan untuk review tim mencakup tindakan berikut.

1. Sepakati otorisasi awal hanya untuk akun `ADMIN` aktif. Andaikan role lain diperlukan, tim perlu menetapkan haknya. Identitas petugas harus berasal dari JWT dan akun aktif di database.
2. Sediakan `POST /api/picking/orders/:orderId/cancel` untuk `MENUNGGU_PICKING` dan `SEDANG_DIAMBIL`. Terima kode alasan, keterangan wajib untuk `LAINNYA`, dan konfirmasi pengembalian fisik jika ada reservasi aktif. Tolak order siap packing, memiliki rekaman pengemasan yang menghalangi, atau memiliki handoff atau transaksi downstream terkait.
3. Selaraskan transaksi Orang 1–4 untuk mengambil lock dan memvalidasi ulang kepemilikan reservasi, status serta referensi handoff. Outbound perlu mengaitkan order dan unit ke shipment. Gate Pass perlu menyimpan kaitan unit secara atomik dengan otorisasi. POS perlu memeriksa reservasi aktif bersama status yang dikunci. Bila satu unit belum bisa dibuktikan aman, batalkan seluruh transaksi pembatalan.
4. Dalam satu transaksi, kunci akun, order, reservasi aktif, tag dan item, lalu verifikasi identitas, lokasi rak tercatat, status `RESERVED` pada kedua sisi, konfirmasi fisik dan keadaan downstream. Sesudah lolos, isi `released_at`, ubah tag serta item yang masih dimiliki order ke `IN_STOCK` dengan guard status dan pemeriksaan jumlah baris, simpan `DIBATALKAN`, dan tulis audit sebelum commit. Retry order yang sudah dibatalkan dapat mengembalikan 409 tanpa mutasi tambahan. Timeout harus diikuti pembacaan status.
5. Tampilkan riwayat **Dibatalkan** di luar tiga kolom aktif melalui filter. Riwayat memuat nomor, SKU, jumlah diminta, scan historis, jumlah pelepasan, alasan, keterangan, petugas dan waktu. Audit mencatat status sebelum dan sesudah, snapshot EPC serta status tag/item, dan konfirmasi pengembalian. Bukti pengembalian fisik tetap menjadi tanggung jawab petugas.

## G. Perubahan database dan usulan migrasi

Tiga fitur Picking dan stok berjalan dengan skema existing. Audit read-only memverifikasi UUID produk, tag, item dan lokasi, relasi order–baris–scan, `released_at`, indeks unik parsial, serta tabel dan riwayat Packing. CHECK `picking_orders_status_check` hanya menerima `MENUNGGU_PICKING`, `SEDANG_DIAMBIL`, dan `SIAP_PACKING`. Trigger kapasitas rak pada item dipicu oleh perubahan lokasi, penyisipan atau penghapusan.

[Usulan SQL 006](sql/proposals/006_orang1_picking_cancellation.sql) memperluas CHECK tersebut dan menambahkan satu event audit terstruktur per order pada `picking_cancellations`. PK event membuat catatan sukses tunggal. Audit menyimpan snapshot aktor, order, alasan, waktu dan unit yang dilepaskan. Rancangan mengaktifkan RLS dan mencabut hak akses langsung role client. `picking_scans` memakai kolom dan indeks yang sudah tersedia. Pencatatan tidak memerlukan pergerakan `stock_movements`.

SQL masih berupa usulan dan belum diterapkan. Penerapan ke Supabase tim memerlukan persetujuan pengguna dan tim, kesepakatan RBAC, serta perbaikan kontrak downstream di bagian F. Sesudah penerapan yang disetujui, verifikasi definisi CHECK, PK/FK dan RLS lewat katalog PostgreSQL. Uji persaingan scan, cancel, shipment, dan Gate Pass, termasuk gagal menyimpan audit atau timeout setelah commit. Verifikasi bahwa data historis tetap bisa dibaca dan saldo ledger tidak berubah oleh transaksi pembatalan.

Jika uji rilis gagal, tahan aktivasi endpoint dan tombol. DDL berjalan dalam satu transaksi. Setelah commit, pemulihan yang aman adalah menahan mutasi pembatalan baru sambil mempertahankan pembacaan status dan audit. Pertimbangkan pengembalian CHECK lama hanya jika terverifikasi belum ada order `DIBATALKAN` atau audit yang bergantung pada skema tersebut.

## H. Hasil pengujian

| Status | Command atau metode | Hasil aktual |
| --- | --- | --- |
| PASS | Backend `npm run build` dan `node_modules\.bin\tsc.cmd --noEmit` | Build CommonJS dan pemeriksaan TypeScript lulus. |
| PASS | Backend `node --import tsx --test tests/picking/availability.test.ts` | 7 tes lulus. Mencakup sesi, UUID, multi-SKU dan total duplikasi, kuantitas invalid, batas stok, rollback, dan klasifikasi penolakan scan. |
| PASS | Backend `npm run test:orang1` | 53 tes in-memory lulus. 4 tes PostgreSQL ditandai skip oleh runner. |
| PASS | Backend `node --import tsx --test tests/orang1-main-integration.test.ts tests/mqtt-transport.test.ts` | 7 tes lulus, termasuk kontrak endpoint lama dan publikasi MQTT ke listener TCP pengujian. |
| PASS | Frontend `npm run build` | Build Vite lulus. Vite memberi peringatan ukuran chunk di atas 500 kB. |
| PASS | Frontend `npm run test:orang1` dan `node --test tests/picking-api.test.mjs` | 13 tes existing dan 4 tes baru lulus. |
| PASS | Frontend `node --test tests/picking-ui.test.mjs` | 1 skenario Chrome headless lulus. Jalankan sesudah build dengan `PLAYWRIGHT_MODULE` menunjuk modul Playwright dan `PICKING_TEST_CHROME` menunjuk executable Chrome. Skenario menguji login mock, Kanban, ganti SKU, stok nol, perubahan stok saat simpan, checklist sebagai satu-satunya pilihan pada kedua modal, keyboard, batch parsial, reload, penambahan stok mock, pembacaan ulang setelah respons scan tidak lengkap, checklist dan finalisasi Packing. |
| PASS | Node.js + `pg`, repository hasil build dalam `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY` | Supabase tim berhasil dibaca. Rumus, kandidat dan histori konsisten pada 4 order/4 baris. Ada 1 baris dengan kandidat dan 1 baris kekurangan stok. Ketersediaan dibaca untuk 8 SKU. |
| NOT RUN | `tests/picking/picking.test.ts`, `packing.test.ts`, `inbound.test.ts`, `http.test.ts`, dan QA migrasi yang butuh PostgreSQL | Runner existing membuat PostgreSQL lokal dan menjalankan fixture/migrasi. Persaingan transaksi tulis PostgreSQL serta handoff langsung di Supabase tim belum diuji. |
| NOT RUN | E2E RFID fisik dan transaksi tulis melalui `localhost:3000` | Uji memerlukan reader atau data dan tindakan transaksi yang disetujui tim. |
| BLOCKED | Pembatalan, release, riwayat Dibatalkan dan uji lintas modul | Menunggu persetujuan skema, RBAC dan kontrak integrasi. |

## I. Panduan pengujian manual di localhost

Buka [localhost:3000](http://localhost:3000) setelah menjalankan `npm run dev` di masing-masing repo menggunakan konfigurasi tim. Login dengan akun gudang yang sah dan buka **Picking & Packing**. Mulai dengan pemeriksaan baca. Gunakan pesanan, EPC dan rak yang disetujui sebelum menyimpan atau memvalidasi. Angka Monitor berikut adalah kondisi uji yang harus tersedia dari data yang sah.

1. **Order Monitor lima unit, stok lima.** Pilih Monitor pada form. Pastikan stok menampilkan 5, lalu masukkan 5 dan simpan. Cek kartu Menunggu Picking dan progres 0/5. Buka **Mulai Picking** dan verifikasi lima EPC `IN_STOCK` beserta rak. Pastikan mencentang tidak menaikkan progres sampai **Validasi Scan** ditekan.
2. **Lima unit diminta, stok dua.** Pilih Monitor yang hanya memiliki dua unit layak. Isi 5. Simpan harus nonaktif. Tekan **Gunakan jumlah tersedia (2 unit)** dan cek input berubah menjadi 2. Jika stok berkurang di sesi lain sewaktu form terbuka, verifikasi Simpan menampilkan penolakan dan meminta stok terbaru ketika permintaan melampauinya.
3. **Order lama atau stok berubah.** Cari pesanan aktif yang sisa kebutuhannya melampaui stok. Muat ulang Kanban, periksa indikator kekurangan, lalu buka modal. Cocokkan angka stok keseluruhan dan jumlah checkbox. Jika stok nol, cek pesan kosong dan pastikan tombol Validasi Scan nonaktif.
4. **Picking parsial.** Pilih sebagian unit lalu tekan **Validasi Scan**. Cek progres, kartu Sedang Diambil dan riwayat. Muat ulang browser, buka kartu dan pastikan scan sebelumnya tetap tercatat. Jika EPC sudah diambil dari sesi lain, verifikasi penolakan per EPC serta ringkasan transaksi yang berhasil.
5. **Stok bertambah dan Lanjut Picking.** Setelah barang yang disetujui melewati GRN, encoding dan Putaway, buka **Lanjut Picking**. Cek kandidat baru, validasi sisa EPC, lalu cek kartu pindah ke Siap Packing. Buka **Checklist Packing**, simpan lima pemeriksaan, lalu selesaikan Packing jika diizinkan.

Langkah 6–10 merupakan kriteria verifikasi setelah pembatalan dirilis melalui perubahan yang disetujui. Semua skenario ini berstatus **BLOCKED** pada checkout saat ini.

6. **Batal sebelum ada scan.** Gunakan order Menunggu Picking, pilih alasan, konfirmasi, lalu cek bahwa order muncul di filter Dibatalkan dengan nol EPC yang dilepas. Cek tag dan item yang tersedia tetap seperti sebelumnya.
7. **Batal setelah Picking parsial.** Gunakan order Sedang Diambil dengan reservasi aktif. Pastikan barang telah dikembalikan fisik ke rak tercatat. Coba konfirmasi tanpa checkbox untuk memeriksa penolakan. Sesudah konfirmasi sah, cek order dan histori, `released_at`, status tag/item serta audit.
8. **Blokir pembatalan ketika barang sudah diotorisasi.** Gunakan kasus downstream yang sudah disetujui tim dengan tag atau item `AUTHORIZED_OUT`. Pembatalan harus ditolak, dan seluruh reservasi serta audit order harus tetap konsisten.
9. **Gunakan unit yang telah dilepas.** Buka order aktif lain untuk SKU yang sama. EPC yang dilepas dan masih layak harus dapat muncul sebagai kandidat dan direservasi sekali. Order asal tetap terlihat dalam riwayat.
10. **Bandingkan saldo ledger.** Catat saldo modul Stok per SKU sebelum dan sesudah pembatalan dalam jendela uji yang dikendalikan. Cocokkan mutasi untuk memastikan pembatalan tidak menghasilkan debit atau kredit serta bandingkan jumlah unit layak Picking.

## J. Pemeriksaan akhir

- Perubahan source code berada pada modul Picking Orang 1. File Inbound MVP 1, aturan Packing, modul Orang 2–4, serta konfigurasi MQTT, Supabase, port dan `.env` dipertahankan.
- Tiga kolom, detail order, rak, progres dan histori terlihat melalui alur Picking. Skenario Chrome mock mencakup Simpan Checklist dan Selesai Packing. Pengujian antar-modul pada transaksi Supabase masih tertunda.
- Jalur pembuatan order hanya menulis header dan baris. Scan menulis tag, item, histori dan status order menggunakan transaksi existing. Keduanya tidak menulis ledger. Pembatalan belum aktif.
- Supabase tim hanya dibaca untuk audit dan validasi query. Tidak ada eksekusi migrasi, seed, reset, perubahan data bersama, commit, push, merge, atau deployment. Hasil audit yang dicatat berupa metadata teknis dan agregat tanpa credential.

## K. Blocker dan keterbatasan

Pembatalan membutuhkan keputusan Orang 2, Orang 3 dan Orang 4 mengenai kepemilikan reservasi, hubungan shipment/penjualan/pass dengan unit, dan urutan lock. Perlu persetujuan tim untuk peran pembatalan, pengembalian fisik, status `DIBATALKAN`, dan migrasi.

Perbandingan read-only pada delapan SKU menemukan enam saldo ledger yang berbeda dari jumlah EPC layak Picking. Pada tiga SKU, saldo ledger lebih rendah dari jumlah EPC layak. Tidak ditemukan perbedaan indikator `IN_STOCK` antara tag dan item yang terhubung di lokasi rak. Ledger dan ketersediaan menghitung hal yang berbeda, sehingga selisih perlu direkonsiliasi per unit oleh Orang 2 sebelum diklasifikasikan sebagai bug data. Query Picking tidak memakai ledger sebagai syarat.

Validasi di Chrome memakai API mock. Tes tulis PostgreSQL, perangkat RFID fisik, dan handoff Picking–Pengiriman–Gate Pass di Supabase tim belum diuji. Asal perubahan adalah `main` lokal kedua repo. Saat menyelaraskan ke `origin/main`, tinjau kembali kontrak Picking dan status handoff `DIKIRIM` yang diperkenalkan oleh commit remote.
