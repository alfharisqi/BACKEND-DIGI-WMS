# API Picking & Packing MVP 2

Endpoint Picking memakai envelope `{ success, message, data }`. Kirim JWT dari login DigiWMS sebagai `Authorization: Bearer <token>`. API menerima akun UUID aktif dengan role ADMIN, SUPERVISOR, WAREHOUSE_STAFF, atau OPERATOR. Middleware Picking memverifikasi tanda tangan HS256 menggunakan `JWT_SECRET` yang dikonfigurasi layanan. Ketika konfigurasi tersebut tidak tersedia, permintaan dengan token mendapat 503. UI menggunakan token yang disimpan oleh halaman login existing.

## GET /api/picking/orders

Tanpa filter, API mengembalikan pesanan picking pada semua tahap, diurutkan menurut waktu pembuatan dan UUID. Filter opsional `?status=MENUNGGU_PICKING`, `SEDANG_DIAMBIL`, atau `SIAP_PACKING`. Filter tidak dikenal menghasilkan 400. Daftar tanpa pesanan menghasilkan `data: []`.

| Field | Makna |
|---|---|
| `id`, `order_number`, `status` | UUID pesanan, nomor bisnis, tahap Kanban |
| `requested_qty`, `picked_qty` | Total kebutuhan dan jumlah scan yang reservasinya masih aktif |
| `lines[].product_id`, `sku`, `product_name` | Identitas produk asli pada setiap baris |
| `lines[].requested_qty`, `picked_qty` | Kebutuhan dan progres per SKU |
| `lines[].remaining_qty` | Sisa kebutuhan per SKU, dengan minimum nol |
| `lines[].available_qty`, `shortage_qty` | Jumlah EPC layak untuk baris aktif dan selisih terhadap sisa kebutuhan |
| `lines[].locations[]` | Kandidat rak fisik saat baca, dengan `id`, `code`, `name`, dan `available_qty` |
| `lines[].scans[]` | Bukti EPC, UUID scan/item/tag, snapshot kode dan nama rak, waktu, dan flag reservasi aktif |

Lokasi berasal dari `items.location_id → locations.id`. Unit yang layak terhubung dengan tag ber-EPC yang dapat divalidasi, memiliki status tag dan item `IN_STOCK`, berada di `RACK`, dan bebas reservasi aktif. Pada order tertentu, riwayat item atau tag dari order tersebut juga mengecualikan unit dari daftar pilihannya. Rak asal dan flag reservasi setiap scan tetap tersedia dalam histori.

## GET /api/picking/availability

Kirim `?product_id=<UUID>`. Respons `data` memuat `product_id`, `sku`, `product_name`, dan `available_qty`. Produk yang ada dapat memiliki stok nol. UUID yang salah mendapat 400 dan UUID produk yang tidak ditemukan mendapat 404.

## GET /api/picking/orders/:orderId/available-epcs

Respons `data` memuat `order_id` dan `lines` dari order tersebut. Tiap baris menambahkan `candidates[]` dengan `epc`, `tag_status`, `item_status`, `location_code`, dan `location_name`. Backend mengurutkan kandidat menurut kode rak lalu EPC dan mengambil maksimal `min(remaining_qty, available_qty)` per SKU. Baris yang terpenuhi dan order yang sudah `SIAP_PACKING` mengembalikan pilihan kosong.

Kedua endpoint ketersediaan hanya membaca snapshot saat permintaan diproses. Scan memvalidasi ulang setiap unit saat transaksi berlangsung.

## POST /api/picking/orders

Kirim `order_number` sepanjang 1–80 karakter dan `lines` yang berisi minimal satu `{ product_id, requested_qty }`. Kuantitas harus berupa angka JSON bulat positif. Backend menggabungkan permintaan untuk UUID produk yang sama sebelum membandingkannya dengan ketersediaan. Stok kurang mendapat 409, dengan jumlah diminta dan jumlah tersedia pada pesan. Satu transaksi memeriksa akun dan stok lalu menyimpan header dan baris. Respons HTTP 201 memuat order baru. EPC tetap tersedia sampai transaksi scan pertama yang berhasil.

## POST /api/picking/scan

```json
{
  "order_id": "b5a28c6c-2d4c-43d7-8e6d-6f9ffe070cab",
  "epc": "30A1B2C3D4E5F60000000001"
}
```

API memangkas spasi dan menormalkan huruf EPC menjadi kapital. Format yang diterima adalah 24 digit heksadesimal, atau format lama empat grup heksadesimal yang digunakan MVP 1. Permintaan harus cocok dengan nilai EPC yang sudah terdaftar. ID UUID dipertahankan sebagai string.

Pada HTTP 200, `data.scan` mengembalikan identitas dan lokasi scan, `data.order` mengembalikan pesanan beserta progres terbaru, dan `data.tag_status` serta `data.item_status` masing-masing bernilai `RESERVED`. Scan pertama yang belum mencukupi pesanan menghasilkan `SEDANG_DIAMBIL`. Jika kebutuhan setiap SKU terpenuhi, scan terakhir menghasilkan `SIAP_PACKING`. Untuk pesanan satu unit, satu scan dapat langsung membuatnya siap packing.

Penolakan bisnis yang spesifik terhadap satu EPC menyertakan `code: 'PICKING_SCAN_REJECTED'` dengan HTTP 404 atau 409. UI mengirim satu permintaan per EPC secara berurutan dan dapat meneruskan EPC berikutnya setelah penolakan yang ditandai ini. Jika terjadi kegagalan lain, UI menghentikan batch dan membaca ulang order, histori, serta kandidat. Transaksi yang telah berhasil tetap tercatat.

| HTTP | Kondisi |
|---|---|
| 400 | UUID, format EPC atau filter status salah |
| 401 | Token hilang, kedaluwarsa, tidak valid, atau ID akun bukan UUID |
| 403 | Role tidak memiliki akses Picking |
| 404 | Order atau EPC tidak ditemukan |
| 409 | EPC ganda, reservasi lain, salah SKU, tidak ada item atau rak, kondisi bukan IN_STOCK, kuantitas terpenuhi, atau konflik lock |
| 500 | Galat transaksi di luar konflik yang dikenal. Periksa progres melalui GET sebelum mencoba lagi |
| 503 | Database, skema, atau konfigurasi autentikasi belum siap |

## Kontrak sumber order dan serah terima

Produsen pesanan yang disepakati tim menulis satu `picking_orders` dan seluruh `picking_order_lines` dalam satu transaksi. Gunakan nomor pesanan bisnis unik dan `product_id` UUID yang merujuk produk existing. Gabungkan permintaan SKU yang sama ke satu baris. Terbitkan pesanan ketika seluruh baris valid, dengan kuantitas positif. Proses picking memiliki kepemilikan atas status setelah publikasi. Perubahan order yang sudah diproses memerlukan prosedur pembatalan atau koreksi bersama.

Orang 2 dapat membaca pesanan `SIAP_PACKING` dan UUID `item_id`/`tag_id` dari scan aktif. Pada transaksi pengiriman, kunci pesanan serta unit yang akan dikonsumsi, periksa kepemilikan reservasi dan status, lalu serahkan pemotongan stok dan ledger ke modul Outbound. Orang 3 perlu memeriksa kedua status `IN_STOCK` serta reservasi aktif di dalam transaksi POS, dengan lock yang sama pada tag dan item. Orang 4 dapat memakai identitas hasil serah terima pengiriman untuk otorisasi Gate Pass. Kontrak tersebut perlu disepakati sebelum menghubungkan produsen dan konsumen di Production.

`released_at` disediakan agar transaksi downstream terotorisasi kelak dapat menyelesaikan atau melepas reservasi tanpa menghapus bukti scan. Picking menulis reservasi melalui endpoint scan. Packing membaca reservasi aktif dan menyimpan pemeriksaan serta finalisasi melalui [endpoint Packing](ORANG1_MVP2_PACKING_REPORT.md#api-dan-skema). Pelepasan reservasi tetap menjadi bagian transaksi downstream.

Transaksi memakai lock baris untuk order, tag, item, dan baris SKU, disertai keunikan reservasi aktif untuk tag dan item. [Dokumentasi lock PostgreSQL](https://www.postgresql.org/docs/16/explicit-locking.html) · [Dokumentasi partial index](https://www.postgresql.org/docs/16/indexes-partial.html)

## Review migrasi 002

Gunakan skema staging UUID yang memiliki `products`, `tags`, `items`, `locations`, dan `users`. Tinjau migration 002 sebagai satu transaksi, dengan role yang dapat membuat tabel dan role backend yang memiliki akses tabel serta kebijakan RLS yang sesuai. Audit saat ini menemukan backend Production memakai role `postgres` dengan BYPASSRLS. Penerapan ke lingkungan lain memerlukan pengecekan role yang sama atau pemberian hak minimum serta policy khusus. Roles database API `anon`, `authenticated`, dan `service_role` tidak membutuhkan akses langsung ke tabel Picking.

Contoh verifikasi staging setelah penerapan yang disetujui.

```sql
BEGIN READ ONLY;
SELECT relname, relrowsecurity
FROM pg_class
WHERE relnamespace = 'public'::regnamespace
  AND relname IN ('picking_orders', 'picking_order_lines', 'picking_scans');

SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename IN ('picking_orders', 'picking_order_lines', 'picking_scans')
ORDER BY indexname;
ROLLBACK;
```

Harapkan tiga tabel dengan RLS aktif serta dua indeks unik aktif untuk item dan tag. Jalankan tes regresi PostgreSQL QA sebelum mengaktifkan endpoint di lingkungan bersama.
