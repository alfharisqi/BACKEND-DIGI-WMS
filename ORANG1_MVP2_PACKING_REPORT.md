# DigiWMS MVP 2 — Penyempurnaan Picking & Packing

Panduan operasional dan QA terisolasi untuk alur Picking dan Packing Orang 1.

## Perilaku di browser

- **Detail** membuka tampilan baca saja. Modal menampilkan nomor dan waktu pembuatan order, status Picking dan Packing, progres, produk, SKU, kuantitas, rak, serta EPC dan riwayat scan dengan waktu dan petugas jika tercatat. Setelah finalisasi, modal juga menampilkan waktu dan petugas pengemasan.
- **Checklist Packing** tersedia setelah Picking lengkap. Petugas memeriksa jumlah fisik, EPC, kondisi barang, kemasan, dan label. Centang atau batalkan centang, lalu tekan **Simpan Checklist** untuk menyimpan ke PostgreSQL.
- **Selesai Packing** aktif setelah kelima pemeriksaan disimpan dan seluruh EPC yang diperlukan masih direservasi. Operator mengonfirmasi, status menjadi `SELESAI_PACKING`, dan checklist terkunci. Kartu tetap berada di kolom **Siap Packing** dengan badge **Packing Selesai**. Filter status packing memisahkan order selesai dan order yang menunggu pengemasan.

## API dan skema

Semua endpoint memakai JWT bertanda tangan dan role `ADMIN`, `SUPERVISOR`, `WAREHOUSE_STAFF`, atau `OPERATOR`. Perubahan juga memeriksa UUID, status akun, dan role aktor di database. UUID dan body tidak valid menghasilkan `400`. Sesi tidak valid menghasilkan `401`, akses role ditolak menghasilkan `403`, order tidak ditemukan menghasilkan `404`, dan Picking tidak lengkap, checklist terkunci, atau revisi basi menghasilkan `409`.

| Metode dan path | Kontrak |
|---|---|
| `GET /api/picking/orders/:orderId/packing` | Mengambil order, hasil verifikasi reservasi (`picking_complete`), status packing, lima pemeriksaan, revisi, waktu, dan petugas yang tersimpan. Draft awal memiliki revisi `0`. |
| `PATCH /api/picking/orders/:orderId/packing-checklist` | Menerima `{ revision, checklist }`. Objek `checklist` wajib berisi Boolean `quantity_checked`, `epc_checked`, `condition_checked`, `packaging_checked`, dan `label_checked`. |
| `POST /api/picking/orders/:orderId/packing-complete` | Menerima `{ revision }`. Pengiriman ulang setelah selesai mengembalikan snapshot final yang sama tanpa menulis audit lagi. |

`GET /api/picking/orders` menambahkan `packing_status`. `POST /api/picking/scan` tetap menjalankan reservasi Picking dan menambahkan identitas petugas pada riwayat scan yang dikembalikan. `SIAP_PACKING` tetap menjadi status Picking.

Migrasi `003_orang1_packing.sql` menambahkan `picking_packing` dan `picking_packing_events`, RLS, serta indeks unik untuk satu event finalisasi per order. Launcher mencatat checksum migrasi yang sudah berhasil pada cluster lokal terverifikasi. Tabel packing menyimpan revisi, UUID petugas, dan timestamp. Tabel audit menyimpan snapshot checklist dan identitas pada setiap penyimpanan serta finalisasi. Kunci order dan revisi mencegah perubahan tertimpa. Penulisan status dan event memakai satu transaksi. Terapkan migrasi 003 ke lingkungan yang disetujui sebelum menjalankan backend yang menggunakannya. [SQL migrasi](sql/migrations/003_orang1_packing.sql)

## Menjalankan dan membuat data latihan

Dari checkout `FRONTEND-DIGI-WMS`, jalankan `npm run dev` dan login sebagai `admin.dev`. Password awal tersedia di `%LOCALAPPDATA%\DigiWMS\Development\login-password.txt`. Tekan **Ctrl+C** di terminal launcher untuk berhenti. `npm run dev` berikutnya menggunakan cluster dan data yang sama. [DigiWMS Development](http://localhost:3000)

Dari terminal kedua di folder frontend, jalankan `npm run dev:seed-packing` untuk menyiapkan tiga order manual atau membaca kembali EPC dan raknya. Untuk menambah tiga order baru setelah batch awal digunakan, jalankan `npm run dev:seed-packing -- --new-batch`. Setelah memverifikasi registry dan identitas cluster, seed menambahkan tag, item, dan catatan `PUTAWAY` sintetis pada lokasi bertipe `RACK`. Batch manual tetap tersedia setelah pengujian karena tes browser memakai batch yang berbeda.

Gunakan nomor order, EPC valid, EPC pembanding dan rak dari keluaran seed lokal.

1. Buka **Picking & Packing** dan cari `DEV-PACK-MANUAL`. Buka **Detail** untuk membaca rincian sebelum scan.
2. Untuk mencoba progres parsial, buka **Mulai Picking** pada order `02`. Masukkan EPC pembanding lalu dua EPC keyboard satu per satu untuk melihat progres `1/2` dan `2/2`. Gunakan order `03` untuk mencoba dua SKU dalam satu order.
3. Buka **Checklist Packing**, centang sebagian, simpan, lalu muat ulang halaman dan buka kembali order. Lanjutkan kelima pemeriksaan, simpan, tekan **Selesai Packing**, dan konfirmasi.
4. Pilih **Packing Selesai** di filter status packing. Buka **Detail** dan periksa waktu serta petugas. Muat ulang atau mulai ulang launcher untuk melihat data yang tersimpan.

## Pengujian

Jalankan suite database dan API dari checkout backend.

```powershell
node --import tsx --test tests/picking/picking.test.ts tests/picking/packing.test.ts
```

Runner membuat database disposable, order, SKU dan EPC sintetis. Untuk uji Chrome dan Newman, ikuti [panduan QA lokal](DIGIWMS_DEVELOPMENT.md#tes-ulang-pada-cluster-disposable). Gunakan seed batch baru untuk mengulang latihan manual.

## Serah terima kepada Orang 2 dan Orang 4

Orang 2 dapat memakai `SELESAI_PACKING` sebagai sinyal kesiapan penyerahan untuk transaksi pengiriman, pelepasan reservasi, dan ledger outbound. Orang 4 dapat menggunakan status itu sebagai prasyarat proses Gate Pass bersama aturan otorisasi yang dimiliki modulnya. Finalisasi Orang 1 menyimpan hasil pengemasan dan audit. Tag serta item tetap `RESERVED` dan proses Gate Pass belum dipicu.
