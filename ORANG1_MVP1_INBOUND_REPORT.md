# Penyempurnaan Inbound DigiWMS MVP 1 Orang 1

Implementasi 20 November 2026 pada branch `feat/orang1-mvp2-picking`. GRN baru menyimpan beberapa SKU, verifikasi meminta hasil hitung per SKU, dan registrasi RFID memakai kuota baris yang sudah diverifikasi. Respons registrasi mengirim `mode: simulation` dan `hardware_confirmed: false`. Audit mencatat `ENCODE_SIMULATION`.

## Skema, keamanan, dan kontrak API

[`004_orang1_grn_lines.sql`](sql/migrations/004_orang1_grn_lines.sql) menambahkan `goods_receipt_lines` dengan UUID, jumlah positif, waktu pembuatan, dan satu baris per pasangan GRN dan produk. Header `goods_receipts` mempertahankan `total_qty` dan menandai GRN terstruktur memakai `has_sku_lines`. Constraint terdefer memeriksa kesesuaian total header saat commit. FK komposit dari `items.grn_line_id`, `grn_id`, dan `product_id` menjaga asal barang. `items.inbound_purpose` menandai `RECEIPT`, `ASSET`, atau `SPECIAL`. UUID dan relasi existing tetap berlaku. Migrasi juga menambah `actor_id` pada audit serta memperluas CHECK status UUID Development yang terverifikasi untuk `DIBATALKAN` dan `DAMAGED`. Definisi CHECK yang berbeda membuat migrasi berhenti dan rollback. Migrasi 001–003 tidak diedit.

Mutasi Master SKU, GRN, dan tag memakai JWT HS256 yang sama dengan Picking, serta mencocokkan role dan akun aktif di `users`. Role gudang dapat membuat dan memverifikasi GRN serta mendaftarkan tag. Pembatalan, koreksi, dan kategori tanpa GRN memerlukan Admin atau Supervisor pada skema baru. Identitas verifikasi dan registrasi berasal dari akun tervalidasi. Audit menyimpan aktor, waktu, alasan jika relevan, dan snapshot. Mutasi runtime gagal jika PostgreSQL atau audit tidak tersedia. Kontrak GET dan alias `/api/rfid/*` tetap tersedia.

| Endpoint | Kontrak setelah migrasi 004 |
|---|---|
| `POST /api/inbound/grn`, `PUT /api/inbound/grn/:id` | `po_number`, `supplier_name`, `receipt_date` opsional, dan `lines: [{ product_id, received_qty }]`. Jumlah total dihitung server. Edit hanya untuk draft dengan rincian. |
| `PATCH /api/inbound/grn/:id/verify` | Kirim hasil hitung `lines` lengkap per SKU. Perbedaan terhadap draft menghasilkan `409` sampai rincian diperiksa dan disunting pada draft. `verified_by` dan `verified_at` disimpan dari sesi dan server. |
| `GET /api/inbound/grn` dan `GET /api/inbound/grn/:id` | Header, rincian SKU, `tagged_qty` dan `received_qty` per SKU, progres keseluruhan, serta status tagging hasil hitung. Detail memuat audit. |
| `POST /api/tags/encode` | `grn_id`, `grn_line_id`, tipe dan EPC opsional. SKU diambil dari baris GRN. `product_id` tambahan yang bertentangan ditolak. Untuk kategori non-GRN, kirim `inbound_purpose` dan `product_id`. |
| `PATCH /api/tags/:id/deactivate` | Alasan wajib. Tag `DAMAGED` dan item lama disimpan sebagai histori. Tag rusak tidak dihitung pada kuota aktif. |
| `POST /api/tags/:id/replace` | Alasan wajib, `epc` opsional. Tag lama dikarantina dan tag pengganti dicatat di baris yang sama dalam satu transaksi. Jika EPC duplikat atau penulisan audit gagal, keduanya rollback. |

Satu PO tetap memiliki satu GRN. Sistem belum mempunyai sumber kuantitas PO per SKU, sehingga verifikasi memakai pembandingan dengan draft penerimaan. Integrasi data PO dan persetujuan selisih terhadap PO menunggu sumber data dan kebijakan tim. GRN legacy tetap terbaca dengan pesan **Rincian SKU belum tercatat**. Jika diperlukan tagging baru dari dokumen legacy, Supervisor perlu merekonsiliasi dokumen dengan bukti penerimaan asli dalam proses terpisah yang disetujui tim. Riwayat tag tidak digunakan untuk mengarang kuantitas penerimaan.

Progres menghitung relasi aktif dari item dan tag `ENCODED`, `IN_STOCK`, `RESERVED`, `AUTHORIZED_OUT`, atau `EXITED`. `DAMAGED` tidak menempati slot baru. Status dan progres dihitung setiap pembacaan, sehingga GRN tetap `SELESAI` setelah pemindaian, Putaway, atau Picking. Transaksi Inbound memakai lock tabel existing untuk menyerialkan pemakaian slot dan koreksi terhadap Putaway. Tinjau durasi dan urutan lock bersama Orang 2 sebelum beban operasional tinggi. Koreksi meja menolak item di rak, tag dengan riwayat transaksi, serta unit `RESERVED`. Koreksi setelah Putaway memerlukan reversal terotorisasi bersama Orang 2 dengan ledger tetap append-only.

Master SKU mengambil **Saldo Ledger** dan **Tersedia di Rak** dari API Orang 2. Kolom rak menghitung `IN_STOCK`, sehingga unit `RESERVED` tetap bisa tercakup di saldo ledger meskipun tidak tersedia untuk Picking baru. Jumlah khusus `RESERVED` belum disediakan API stok yang dipakai halaman ini. Snapshot `products.current_stock` tetap tersedia dalam detail Master SKU dengan label stok tercatat. Perhitungan Orang 2 tidak diubah.

## Pengujian

Jalankan suite Inbound/Putaway PostgreSQL dari backend dengan `node --import tsx --test tests/picking/inbound.test.ts`. Suite memakai database disposable dan menyiapkan sendiri akun, SKU, GRN dan EPC. [Panduan QA](DIGIWMS_DEVELOPMENT.md#tes-ulang-pada-cluster-disposable)

## Praktik di localhost

Dari checkout `FRONTEND-DIGI-WMS`, jalankan `npm run dev`. Login sebagai `admin.dev` dengan password Development di profil lokal. Tekan **Ctrl+C** dari terminal launcher untuk berhenti. Startup berikutnya membuka database yang sama. [DigiWMS Development](http://localhost:3000)

1. Pada **Penerimaan (Inbound)**, cari `DEV-IN-LATIHAN-0153156591`. Buka **Detail**, lalu **Verifikasi** dan isi kuantitas fisik sesuai baris, yaitu keyboard 1 dan mouse 2.
2. Pada **Tag & Encoding**, pilih **Registrasi Tag Simulasi**, GRN tadi, dan baris SKU. Pakai EPC latihan berikut atau tombol **Generate**.
3. Coba kirim EPC yang sama lagi untuk melihat penolakan. Setelah tiga registrasi valid, buka Detail GRN untuk melihat progres **3/3**.
4. Lanjutkan ke Putaway Orang 2 pada rak Development yang tersedia. Unit yang sah berubah menjadi `IN_STOCK`, dan ledger mendapat satu mutasi `PUTAWAY` per unit.

| SKU | Jumlah | EPC latihan untuk diregistrasi |
|---|---|---|
| `DEV-IN-0153156591-MOUSE` | 2 | `744B2B4BACE7AF614127AB92`, `C9F5CF7521AEFF0E95F63647` |
| `DEV-IN-0153156591-KEYBOARD` | 1 | `6C03A3B6596DA0C8D000F1BC` |

Batch integrasi `DEV-IN-SMOKE-0153156591` dan order `DEV-IN-PICK-0153156591` menyimpan bukti tes selesai. GRN latihan terpisah tersedia untuk verifikasi dan registrasi manual.

## Batas integrasi

[Kontrak dengan Orang 2](ORANG1_ORANG2_INTEGRATION_CONTRACT.md) masih PROPOSED. Verifikasi hardware RFID dan review SQL Production dilaksanakan terpisah.
