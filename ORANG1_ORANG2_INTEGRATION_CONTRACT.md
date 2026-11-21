# Usulan kontrak Picking Packing ke Outbound DigiWMS

**PROPOSED untuk ditinjau Orang 1, Orang 2, Orang 3, dan Orang 4.** Dokumen ini mengusulkan kontrak tim. Acuan pembagian peran, alur, REST, dan MQTT ada di `Panduan_Eksekusi_DIGI_WMS_MVP2.pdf` halaman 1–4.

## Posisi saat ini

Orang 1 menyediakan `GET /api/picking/orders`, `POST /api/picking/scan`, dan API Detail/Checklist/finalisasi Packing. Scan yang sah mengubah tag dan item menjadi `RESERVED`. Picking tetap `SIAP_PACKING` setelah Packing mencapai `SELESAI_PACKING`. Pada tahap itu, paket dapat dinilai untuk handoff. Penulisan saldo outbound dan penerbitan Gate Pass menjadi pekerjaan downstream. [Rute Orang 1](src/modules/orang1-picking/routes.ts#L37) · [Validasi dan finalisasi Packing](src/modules/orang1-picking/packing.ts#L102)

| Kategori | Keadaan di checkout yang diaudit |
|---|---|
| **Diimplementasikan** | Header `picking_orders`, baris SKU, histori scan, stok yang direservasi, checklist, dan audit finalisasi. `order_number` unik secara global. Satu order memiliki maksimal satu baris per produk. |
| **Fixture dan seed** | Order dibuat lewat `sql/development/seed.sql`, `scripts/dev-seed-packing.cjs`, atau fixture/skrip smoke QA. Order data uji warehouse telah dipakai untuk demo. |
| **Belum tersedia** | Feed order dari POS atau sistem pesanan gudang, API membuat/membatalkan order, aktor aplikasi yang berwenang membuatnya, kunci referensi bisnis, dan relasi order ke shipment. Handler aktif untuk Outbound shipment, POS checkout, dan Gate Pass tidak ditemukan di worktree. Menu Pengiriman memperbarui state React dari form contoh, termasuk nomor Gate Pass contoh. |
| **Belum ada sumber** | Pelanggan, alamat/tujuan, kurir, resi, dan nilai transaksi pada order Picking. Contoh dari UI Pengiriman belum merupakan catatan transaksi persisten. |
| **Perlu keputusan** | Satu sumber order yang berwenang, format referensi bisnis, penanganan split shipment, kapan stok didebit, dan kebijakan pembatalan/release. |

Simulasi Pengiriman berada di `src/modules/orang2-inventory/InventoryLedgerPage.jsx` pada repo frontend. [Seed Development](sql/development/seed.sql#L29) · [Seed batch latihan](scripts/dev-seed-packing.cjs#L65) · [Skema order](sql/migrations/002_orang1_picking.sql#L6)

Saat ini, retry pembuatan order eksplisit masih terbatas pada keunikan nomor order di database dan perilaku seed. Belum ada pembatalan order Picking yang mengisi `released_at`. Belum ada penjaga POS lintas modul untuk memastikan unit `RESERVED` untuk gudang tidak digunakan kasir. Ketentuan itu harus ditegakkan dalam kontrak baru. [Aturan reservasi yang ada](src/modules/orang1-picking/repository.ts#L75) · [Indeks aktif](sql/migrations/002_orang1_picking.sql#L37)

## Handoff dan pemilik

| Tahap | Pemilik | Kondisi |
|---|---|---|
| Order gudang → Picking → Packing | Orang 1, sumber order menunggu keputusan tim | EPC dan kuantitas tepat. Tag serta item `RESERVED`. `SIAP_PACKING` dan `SELESAI_PACKING` dibaca sebagai dua field. |
| Konsumsi handoff → Shipment → Ledger | Orang 2 | Buat rekaman persisten kurir dan resi. Ledger `OUTBOUND_SHIPMENT` bernilai negatif dan hanya ditulis satu kali. Tag masih `RESERVED` saat shipment sukses, sampai langkah Orang 4. |
| Gate Pass → Otorisasi | Orang 4 | Gate Pass hanya untuk shipment yang sudah commit dan unit yang masih sah. Orang 4 mengatur `AUTHORIZED_OUT`, masa berlaku, audit, dan pembatalan otorisasi. |
| POS dan retur | Orang 3 | Alur POS dan warehouse memakai aturan kepemilikan item/tag bersama. POS dapat memiliki alur reservasi terpisah jika disepakati. |

## Contoh payload read model — PROPOSED

Contoh sintetis untuk review API. Field `packed_by` dipetakan dari `completed_by` dan audit finalisasi Orang 1. `location_origin` memakai snapshot lokasi scan. Referensi bisnis dan shipment dapat bernilai `null`. Payload tidak memuat pelanggan, alamat, atau resi yang belum tercatat.

```json
{
  "picking_order_id": "77777777-7777-4777-8777-777777777777",
  "order_number": "QA-HANDOFF-001",
  "picking_status": "SIAP_PACKING",
  "packing_status": "SELESAI_PACKING",
  "packing_revision": 3,
  "completed_at": "2026-11-20T06:00:00.000Z",
  "packed_by": "22222222-2222-4222-8222-222222222222",
  "business_reference": null,
  "shipment_reference": null,
  "lines": [
    {
      "product_id": "33333333-3333-4333-8333-333333333333",
      "sku": "QA-MOUSE",
      "quantity": 1,
      "units": [
        {
          "item_id": "44444444-4444-4444-8444-444444444444",
          "tag_id": "55555555-5555-4555-8555-555555555555",
          "epc": "AABBCCDDEEFF001122334455",
          "location_origin": {
            "id": "66666666-6666-4666-8666-666666666666",
            "code": "DEV-A01"
          }
        }
      ]
    }
  ]
}
```

## Rancangan API — PROPOSED

| API | Pemilik dan perilaku |
|---|---|
| `GET /api/outbound/ready-orders?cursor=…` | Orang 2 menampilkan order selesai Packing dengan reservasi aktif, tanpa shipment aktif, dalam daftar berhalaman. Konsumsi data Orang 1 melalui service/read model yang disepakati. Hasil GET bersifat informatif. |
| `POST /api/outbound/shipments` | Orang 2 menerima `picking_order_id`, `packing_revision`, kurir, resi dan referensi tujuan yang valid dari input operasional. Wajib `Idempotency-Key`. SKU, EPC, kuantitas, dan asal diambil ulang dari reservasi dengan lock. |
| `GET /api/outbound/shipments/:id` | Orang 2 menyajikan status shipment/ledger dan referensi Gate Pass jika sudah diterima. Dipakai untuk rekonsiliasi setelah timeout. |
| `POST /api/outbound/shipments/:id/cancel` | Orang 2 menerima alasan dan kunci idempoten. Hanya role koreksi yang disetujui. Aturan berbeda sebelum commit, setelah debit ledger, dan setelah barang keluar. |
| Trigger Gate Pass | Orang 4 mengonsumsi referensi shipment yang sudah commit dan memvalidasi bukti ledger. Rute/consumer serta masa berlaku disepakati Orang 4. |

Blueprint mencantumkan `sales` sebagai rekaman outbound bersama dengan subtype `OUTBOUND_SHIPMENT`. Usulan ini memakai **shipment** sebagai konsep domain/endpoint. Tim perlu menentukan apakah datanya disimpan di `sales` atau detail shipment yang mereferensikan transaksi kanonis. Pemetaan itu harus jelas sebelum menentukan foreign key Gate Pass. Otoritas pembuatan order diusulkan melalui satu jalur ingest yang memerlukan identitas sumber dan kunci unik `(source, external_order_id)`. Haknya belum ditetapkan.

## Transaksi, persaingan, dan recovery — PROPOSED

1. Di satu transaksi PostgreSQL, kunci order dan baca ulang status serta revisi Packing. Kunci scan aktif, tag, dan item dalam urutan yang disepakati untuk seluruh writer. Pastikan per SKU jumlah reservasi tepat, setiap scan belum dilepas, EPC cocok dengan tag, item terkait ke tag dan produk, dan kedua status masih `RESERVED`. Tolak perubahan revisi atau pemilikan dengan `409`. Simpan daftar unit shipment sebagai snapshot.
2. Awali dengan kebijakan satu shipment aktif per order. Gunakan uniqueness untuk order dan referensi shipment, serta simpan key dan hash permintaan yang dinormalisasi. Retry dengan key dan body sama mengembalikan shipment yang sama. Key sama dengan body berbeda, atau key berbeda untuk order yang sudah diklaim, menghasilkan `409`. Sertakan ID shipment pada konflik yang boleh dibaca operator.
3. Dalam transaksi yang sama, simpan shipment, detail unit, ledger outbound, audit, dan outbox. Usulkan `qty_change = -1` per unit supaya traceability EPC tersedia. Jumlah negatif per SKU harus sama dengan kuantitas paket. Gunakan referensi ledger deterministik per shipment dan unit agar debit tidak bisa diulang. Jika satu penulisan gagal, rollback seluruh transaksi. Jangan mengandalkan pemberitahuan MQTT untuk menandai commit.
4. Setelah commit, status shipment menjadi **menunggu otorisasi Gate Pass**. Pertahankan status Picking/Packing. Klaim reservasi menjadi milik shipment dan tetap eksklusif. Selama mekanisme transfer kepemilikan belum diputuskan, jangan mengisi `released_at` saat shipment commit. Pembaca POS harus memeriksa status tag/item dan klaim eksklusif sebelum checkout. Susun urutan lock konsisten agar POS, shipment, Picking, dan koreksi tidak saling mengambil unit.
5. Publikasikan `wms/stock/realtime` dari outbox setelah commit. Jika Gate Pass gagal, retry penerbitan secara idempoten dengan referensi shipment yang sama. Ledger yang sudah commit tidak diulang. Orang 4 mengunci shipment dan unit, memeriksa status serta saldo transaksi yang sah, menerbitkan maksimum satu otorisasi aktif sesuai kebijakan, dan mengubah tag/item ke `AUTHORIZED_OUT` sesuai kontraknya. Sebelum itu, UI tetap menunjukkan otorisasi tertunda.
6. Gagal sebelum commit berarti reservasi Packing tetap tersedia untuk retry. Setelah debit ledger, pembatalan harus melalui mutasi kompensasi append-only yang merujuk shipment asal dan pencabutan Gate Pass bila sudah diterbitkan. Setelah barang keluar, koordinasikan dengan alur retur Orang 3. Pembatalan prashipment yang mengembalikan unit ke `IN_STOCK` memerlukan status lokasi fisik yang sah, audit, dan release atomik. Jangan mengubah pengemasan historis atau mencabut klaim pada transaksi yang belum direkonsiliasi.

Backend wajib memvalidasi JWT bertanda tangan dan akun aktif di database. Rekomendasinya memberi role gudang akses baca seperlunya, petugas Outbound hak membuat shipment, Supervisor hak koreksi, dan role Gate hak otorisasi. Audit mencatat aktor dari sesi, waktu, perubahan, order, revisi Packing, shipment, jumlah/ID EPC, dan hasil retry atau reversal. Kunci dan status transaksi tidak berasal dari callback browser tanpa validasi backend.

## Keputusan tim

- **Orang 2** mengesahkan sumber order, pemilik ingest, struktur shipment terhadap `sales`, satu shipment per order atau split, kapan pengurangan ledger terjadi, dan siapa yang boleh membatalkan. Definisikan bersama saldo ledger, unit fisik di rak/staging, unit tersedia `IN_STOCK`, serta `RESERVED` sebelum dan sesudah debit shipment.
- **Orang 3** menentukan kapan POS memakai Picking dan kapan menggunakan checkout tersendiri. Sepakati penjaga eksklusif yang sama untuk POS dan gudang, urutan lock, integrasi retur, dan penolakan EPC yang sudah dicadangkan pihak lain.
- **Orang 4** menentukan pemicu dan kunci Gate Pass, relasi ke shipment/transaksi kanonis, TTL, aturan retry/revoke, dan kondisi aman untuk `AUTHORIZED_OUT`. Sepakati audit serta sumber otorisasi yang dipakai portal.

## Test plan handoff

| Kasus | Kriteria |
|---|---|
| Order dua SKU hingga Gate Pass | Picking mengambil dari rak aktual. Packing selesai. Shipment memuat unit dan resi persisten. Saldo terdebit tepat sekali. Gate Pass Orang 4 menghasilkan `AUTHORIZED_OUT` setelah commit shipment. |
| Status belum siap, revisi basi, atau reservasi berubah | Shipment ditolak. Tidak ada ledger, outbox, atau Gate Pass. |
| Dua operator dan retry jaringan | Satu shipment, satu set debit dan satu trigger Gate. Payload berbeda dengan key yang sama ditolak. |
| POS dan Outbound bersamaan | Hanya satu pemilik unit. Kondisi kalah menghasilkan konflik yang dapat dibaca dan tidak memotong stok. |
| Kegagalan SQL, broker, atau Gate Pass | SQL mid-transaction melakukan rollback. Broker/Gate Pass gagal setelah commit tercatat untuk retry tanpa debit ulang. |
| Batal sebelum atau sesudah commit | Release dan lokasi konsisten sebelum commit. Sesudah commit, kompensasi dan revocation terhubung ke histori. Barang yang sudah keluar mengikuti retur. |
| RBAC dan audit | Token tidak sah, akun nonaktif, dan role di luar kewenangan ditolak. Audit memuat aktor dan referensi tiap langkah. |

Uji ini menunggu kontrak disetujui dan endpoint implementasi tersedia. Gunakan PostgreSQL disposable dan data sintetis untuk validasi pertama.
