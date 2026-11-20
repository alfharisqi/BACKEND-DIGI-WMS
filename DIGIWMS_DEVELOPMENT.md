# DigiWMS Development lokal

Instal PostgreSQL 16 lokal beserta `initdb`, `pg_ctl`, dan `pg_controldata`. Jalankan `npm ci` di masing-masing repo. Dari checkout frontend, jalankan:

```powershell
npm run dev
```

Tunggu alamat **DigiWMS Development** tercetak, lalu buka `http://localhost:3000`. API Fastify memakai `http://127.0.0.1:5102/api` dan PostgreSQL 16 memakai `127.0.0.1:55436`. Secara default folder `FRONTEND-DIGI-WMS` dan `BACKEND-DIGI-WMS` berada di bawah folder induk yang sama. Launcher menyeleksi backend dari isi checkout, sehingga branch `main` dapat digunakan setelah perubahan di kedua repo tersedia. Untuk lokasi lain, isi `DIGIWMS_DEV_BACKEND_DIR` dengan path checkout backend. Untuk lokasi binari PostgreSQL di luar default Windows, isi `DIGIWMS_DEV_PG_BIN` dengan folder `bin`.

Login menggunakan `admin.dev`. Buka salinan password yang dibuat saat cluster pertama kali disiapkan.

```powershell
notepad "$env:LOCALAPPDATA\DigiWMS\Development\login-password.txt"
```

File password dan `identity.json` berada di profil Windows lokal. Aplikasi menyimpan hash bcrypt untuk akun Development di database. Secrets PostgreSQL dan JWT berasal dari identitas lokal itu, sehingga tetap berlaku setelah restart. Jika password akun diganti lewat aplikasi, gunakan password yang baru. Jangan bagikan kedua file rahasia.

Tekan **Ctrl+C** di terminal tempat launcher berjalan. Jalankan `npm run dev` lagi untuk memuat cluster dan data yang sama. Launcher menghentikan backend miliknya dan PostgreSQL yang dimulainya sendiri. Cluster Development yang sudah berjalan sebelum startup diverifikasi dan digunakan kembali. Jika port terpakai, launcher melaporkan konflik. Hentikan proses dari terminal asal jika memang sesuai. `DIGIWMS_DEV_FRONTEND_PORT` dapat dipakai untuk uji frontend sementara di port lain.

## Data dan batas Development

Cluster dan data berada di `%LOCALAPPDATA%\DigiWMS\Development\pgdata`. Siapkan cadangan dengan menyalin folder Development lengkap saat cluster berhenti, termasuk identitas untuk membuka salinan tersebut. PostgreSQL diinisialisasi sekali dan launcher memeriksa `data_directory`, system identifier, listener loopback, nama database, dan penanda SQL khusus sebelum operasi data. Registry checksum mencatat langkah skema dan seed awal sintetis. Tambahkan perubahan skema sebagai migrasi baru. Launcher akan menolak isi migrasi yang sudah pernah tercatat jika isinya berubah.

Launcher menerapkan migrasi 001–004 pada cluster Development yang terverifikasi. Launcher memilih identitas database lokal dan memasok URL Vite. Secrets dari `.env` backend dan Vite tidak diperlukan untuk workflow ini. MQTT jaringan dinonaktifkan untuk pengujian lokal. Tampilan dashboard dan halaman existing yang masih menyimulasikan sebagian data dan aksi mengikuti perilaku MVP 1. Inbound menyimpan GRN multi-SKU, verifikasi, dan registrasi EPC simulasi. Picking dan Packing memakai order, hasil scan, dan checklist nyata dari PostgreSQL. Proses pengiriman, Gate Pass dan reader RFID fisik berada di luar tes launcher ini. [Panduan praktik Inbound](ORANG1_MVP1_INBOUND_REPORT.md#praktik-di-localhost)

Dashboard SQL terbaru membutuhkan tabel `gate_passes` dan `alarms`. Daftar Gate juga menggunakan tabel `sales`. Tabel tersebut belum ada di skema UUID sintetis launcher, sehingga ringkasan Dashboard dapat mengembalikan HTTP 500 dan daftar Gate dapat memakai fallback. Skema UUID bersama menunggu konfirmasi pemilik modul.

Order awal `DEV-PICK-001` meminta dua unit SKU `DEV-CABLE-01`. EPC `D00100000000000000000001` berada di `DEV-A01` dan EPC `D00100000000000000000002` berada di `DEV-B01`. `D00100000000000000000003` cocok untuk mencoba penolakan karena SKU berbeda. Scan pertama memindahkan order ke **Sedang Diambil**, dan scan kedua membuka **Checklist Packing**. Status yang tersimpan muncul kembali setelah restart. Tes smoke memakai order sintetis lain dengan awalan `SMOKE-PICK-`.

Perintah opsional dari frontend.

| Perintah | Perilaku |
|---|---|
| `npm run dev:frontend` | Menjalankan Vite saja dengan URL API Development 5102. Berguna jika backend telah berjalan. |
| `npm run dev:seed-packing` | Menyiapkan tiga order `DEV-PACK-MANUAL-01` hingga `03` sekali dan mencetak EPC serta rak dari PostgreSQL. Jalankan saat cluster Development aktif. |
| `npm run dev:seed-packing -- --new-batch` | Menambah tiga order latihan dengan nomor dan EPC unik. Gunakan batch baru ketika EPC latihan sebelumnya sudah direservasi. |
| `npm run dev:reset` | Mengarsipkan folder cluster Development terverifikasi yang sudah berhenti. Startup berikutnya membuat cluster dan password baru. Arsip menyimpan data lama serta identitas, dan tetap berada di profil lokal. |

Setelah reset, keluar dari sesi Development lama di browser dan login dengan password baru. Reset bukan bagian dari startup atau pengujian persistensi.

Untuk checkout kandidat yang berada di induk folder berbeda, isi `DIGIWMS_DEV_BACKEND_DIR` dengan path worktree backend kandidat. Untuk menjalankan server Vite saja dengan konfigurasi umum tim, gunakan `node dev-server.js` dari frontend.

## Latihan Detail dan Checklist Packing

Di menu **Picking & Packing**, cari `DEV-PACK-MANUAL`. Buka **Detail** untuk membaca status, SKU, jumlah, rak, dan riwayat scan. Pada order yang dipilih, tekan **Mulai Picking**. Coba EPC dari produk uji salah, lalu masukkan EPC sesuai SKU dan rak dari output seed. Setelah setiap SKU lengkap, buka **Checklist Packing**, konfirmasi kelima pemeriksaan, lalu tekan **Simpan Checklist**. Tekan **Selesai Packing** dan setujui konfirmasi. Kartu memperoleh badge **Packing Selesai** dan dapat dicari menggunakan filter status packing dalam kolom **Siap Packing**. Muat ulang atau buka lagi setelah restart untuk melihat checklist, waktu, dan petugas finalisasi.

Gunakan EPC dan rak dari keluaran seed lokal. [Panduan Packing](ORANG1_MVP2_PACKING_REPORT.md)

## Tes ulang pada cluster disposable

Dari backend, jalankan suite yang membuat fixture sintetis pada PostgreSQL 16 loopback dan memeriksa identitas cluster sebelum menyentuh data.

```powershell
node --import tsx --test tests/picking/inbound.test.ts tests/picking/picking.test.ts tests/picking/packing.test.ts
```

Untuk Chrome dan Newman, build frontend dengan variabel proses `VITE_API_URL=http://127.0.0.1:5102/api`, `VITE_ENABLE_MQTT=false`, dan `VITE_DIGIWMS_LOCAL_DEV=true`. Jalankan `node --import tsx --test tests/picking/http.test.ts` dari backend dengan `ORANG1_PICKING_UI_DIST` menunjuk folder build, `ORANG1_PICKING_TEST_TOOLS` menunjuk instalasi terpisah Newman dan playwright-core, dan `ORANG1_PICKING_EVIDENCE_DIR` menunjuk folder output lokal di luar Git. Suite membuat order, EPC, serta token sendiri. Browser Chrome dapat ditentukan melalui `ORANG1_PICKING_CHROME`.

Uji launcher pada profil baru dapat memakai `LOCALAPPDATA` sementara dan `DIGIWMS_DEV_PG_PORT` yang bebas. Gunakan nilai yang sama di terminal seed. Port default 55436 dan profil Development reguler tetap berlaku untuk penggunaan normal.
