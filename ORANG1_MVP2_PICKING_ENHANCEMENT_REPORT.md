# Laporan final Picking & Packing Orang 1

26 November 2026 · DIGI WMS MVP 2

Rilis ini mengintegrasikan branch `feature/orang1-mvp2-picking-enhancement` ke `main` pada kedua repository. SQL 006 sudah diterapkan pada Supabase tim. Pengguna mengonfirmasi **32 dari 32 checklist manual lulus** melalui localhost dengan Supabase tim.

## Fitur yang selesai

- Kandidat EPC dipilih dari stok rak yang layak. Validasi batch memproses EPC secara berurutan dan menampilkan hasil per EPC. Input EPC manual dihapus dari Picking.
- Pembuatan order memvalidasi stok di backend dan frontend. Order parsial menunjukkan kekurangan per SKU dan dapat dilanjutkan ketika stok tersedia.
- ADMIN aktif dapat membatalkan `MENUNGGU_PICKING` yang memenuhi syarat serta `SEDANG_DIAMBIL` setelah konfirmasi pengembalian fisik. Untuk order parsial, satu transaksi mengubah tag dan item dari `RESERVED` ke `IN_STOCK`, mengisi `released_at`, menetapkan `DIBATALKAN`, dan menyimpan audit. EPC dapat dipakai kembali dan saldo ledger tetap sama.
- Filter **Dibatalkan** menampilkan histori dan audit. Picking dan Packing normal, finalisasi checklist, kolom **Dikirim / Kurir**, Pengiriman, POS, Box, serta Gate Pass tetap tersedia.

## File rilis

| Repository | File |
| --- | --- |
| Backend Picking dan Packing | `src/modules/orang1-picking/{contract,repository,routes,packing,cancellation-reservations}.ts` |
| Backend integrasi | `src/modules/orang2-inventory/{outbound.routes,outbound-handoff}.ts`, `src/modules/orang3-opname/pos.routes.ts`, `src/modules/orang4-dashboard/routes.ts`, `src/modules/gate-authorization.ts` |
| Backend SQL dan dokumentasi | `sql/migrations/006_orang1_picking_cancellation.sql`, `ORANG1_MVP2_PICKING_API.md`, laporan ini |
| Backend automated test | `tests/picking/{availability,cancellation,http,packing-regression}.test.ts`, `tests/{outbound-handoff,gate-authorization}.test.ts` |
| Frontend Picking dan Packing | `src/modules/orang1-picking/{CancellationDialog,PackingDetailsDialog,PickingPackingPage}.jsx`, `src/modules/orang1-picking/api.js` |
| Frontend integrasi dan test | `src/modules/orang2-inventory/InventoryLedgerPage.jsx`, `src/modules/orang4-dashboard/GateSecurityPage.jsx`, `tests/{picking-api,picking-ui}.test.mjs` |

## Perubahan API dan integrasi

- `GET /api/picking/availability` dan `GET /api/picking/orders/:orderId/available-epcs` menyediakan ketersediaan dan kandidat EPC. `GET /api/picking/orders` mengembalikan `can_cancel`. `POST /api/picking/orders/:orderId/cancel` menerima `reason` dan `notes` opsional, dengan keterangan wajib untuk `LAINNYA`. Pembatalan parsial juga mensyaratkan `physical_return_confirmed: true` dan `return_scan_ids` berisi seluruh ID scan aktif. [Kontrak Picking](ORANG1_MVP2_PICKING_API.md)
- `GET /api/outbound/picking-orders?for_handoff=1` dan `GET /api/outbound/pos-orders` memasok pilihan sumber Pengiriman. `POST /api/outbound/shipments` mewajibkan `source` di samping `invoice_or_resi`, `customer_or_destination`, dan `epcs`. Field `courier` dan `total_amount` opsional. Objek `source` memakai `type: PICKING_ORANG1` atau `OUTBOUND_PICKING` dengan `order_id`, `type: POS` dengan `sale_id`, atau `type: STOK_BEBAS` dengan `authorization_id` opsional. Order Orang 1 harus sudah final Packing. Pengiriman dari POS memakai debit ledger penjualan yang sudah tercatat. [Validasi sumber Pengiriman](src/modules/orang2-inventory/outbound-handoff.ts)
- `POST /api/outbound/authorize` menerima `epcs` dan `source` untuk `OUTBOUND_PICKING` atau `STOK_BEBAS`. Payload pengiriman atau otorisasi tanpa `source` ditolak dengan HTTP 409 dan kode `SHIPMENT_SOURCE_REQUIRED`. Muat ulang frontend lama setelah pembaruan.
- Penerbitan Gate Pass mengunci sumber dan EPC, memverifikasi kepemilikan serta status, lalu menyimpan pass, perubahan status RFID, dan daftar EPC dalam satu transaksi. Scan keluar memeriksa keterkaitan EPC dengan pass dan menolak otorisasi yang sudah digantikan. Gate Pass POS mengaitkan unit dan Box ke invoice penjualan yang sah. [Otorisasi Gate Pass](src/modules/gate-authorization.ts)

## Migrasi SQL 006

[SQL 006](sql/migrations/006_orang1_picking_cancellation.sql) adalah salinan identik dari berkas yang telah diterapkan. SHA-256 isi dengan akhir baris LF adalah `a61e45bf9806a34a8aa7f93d6a1ff62aeb932f1d5d585bdfc9b322e0873ea7c4`. **Jangan jalankan ulang pada Supabase tim.** Startup biasa tidak menjalankannya.

- CHECK `picking_orders_status_check` menambah `DIBATALKAN` pada tiga status tersimpan. `DIKIRIM` tetap dihitung untuk tampilan.
- `picking_cancellations` memakai `order_id` sebagai PK sekaligus FK dan mencatat alasan, petugas, waktu, konfirmasi fisik serta unit yang dilepas.
- Trigger `picking_cancellation_terminal` menjaga status akhir. `picking_cancellation_reject_scan` menolak scan pada order batal. `picking_cancellation_protect_reserved_tag` mencegah otorisasi RFID sebelum Packing selesai.
- RLS aktif. Role backend sudah diverifikasi dapat membaca dan menulis audit. `PUBLIC`, `anon`, `authenticated`, dan `service_role` tidak menerima akses langsung ke tabel audit.

## Hasil verifikasi

| Pemeriksaan | Hasil |
| --- | --- |
| Backend | Build dan `tsc --noEmit` lulus. 38 automated test lulus, termasuk Picking, Packing, rollback, konkurensi mock, otorisasi, Pengiriman, POS, Box, dan Gate Pass. |
| Frontend | Build lulus dengan peringatan chunk Vite di atas 500 kB. 18 automated test lulus, termasuk skenario Chrome dengan API mock. |
| Manual | Pengguna mengonfirmasi 32 dari 32 checklist lulus di localhost dengan Supabase tim. Cakupannya termasuk kedua skenario pembatalan, perubahan status RFID, penggunaan ulang EPC, ledger, audit, ADMIN, Picking dan Packing normal, serta Pengiriman, POS, dan Gate Pass. |

Regresi final menggunakan fixture atau mock. Runner PostgreSQL yang membutuhkan database lokal tidak dijalankan. Tidak ada transaksi otomatis pada Supabase tim atau pengubahan data hasil uji manual.

## Jalankan aplikasi dan aktifkan pembatalan

Gunakan `.env` dan autentikasi existing. Jika broker belum berjalan, jalankan `docker compose up -d emqx` dari backend. Backend dijalankan dengan `npm.cmd run dev` pada port 5000 dan frontend memakai `npm.cmd run dev` pada port 3000 dari terminal lain. Cek [health backend](http://localhost:5000/api/health) untuk status Supabase dan EMQX, lalu buka [DIGI WMS](http://localhost:3000/).

Sakelar pembatalan default nonaktif. Untuk mengaktifkannya pada proses backend memakai PowerShell, jalankan berikut dari folder backend.

```powershell
$env:DIGI_WMS_PICKING_CANCELLATION_APPROVED = 'true'
npm.cmd run dev
```

Untuk aktivasi permanen, tetapkan nilai yang sama pada lingkungan proses backend yang sudah diperbarui dan restart setelah seluruh instance penulis memakai versi kompatibel. Backend juga memeriksa kesiapan skema dan akun ADMIN aktif. Untuk menahan pembatalan baru, hapus variabel dari lingkungan peluncur kemudian restart backend kompatibel. Pertahankan skema, audit, dan order historis.

## Pembaruan repository anggota tim

1. Setelah rilis tersedia pada `origin/main` di backend dan frontend, hentikan kedua proses lama. Jalankan `git status --short` di kedua repo dan amankan perubahan lokal sebelum pindah branch.
2. Di tiap repo, jalankan `git fetch origin`, `git switch main`, dan `git pull --ff-only origin main`. Jika tidak bisa fast-forward, koordinasikan integrasi sebelum mencoba lagi.
3. Perbarui **kedua** repository sebelum layanan dipakai kembali. Jalankan `npm.cmd ci` bila dependensi perlu dipasang ulang. Pertahankan `.env` existing. Jalankan hanya backend kompatibel, mulai ulang frontend, dan muat ulang halaman untuk mengambil payload Pengiriman terbaru.
4. Setelah semua instance lama diganti, aktifkan pembatalan secara permanen. Backend lama harus tetap berhenti. Jalur Pengiriman dan Gate Pass lama dapat mengotorisasi EPC yang sudah dilepas ke `IN_STOCK` tanpa memeriksa order sumber, meskipun sakelar pembatalan dimatikan.

Fetch final menegaskan kedua branch sudah memuat `origin/main` pada backend `6169742` dan frontend `c77d19e`. Tidak ada commit tim baru untuk diintegrasikan.

## Pesan commit rilis

- Backend `feat(picking): finalize EPC bulk validation, stock checks and order cancellation`
- Frontend `feat(picking): finalize picking enhancements and cancellation workflow`
