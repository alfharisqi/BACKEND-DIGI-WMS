# Review Final Migrasi Audit Supabase — 9 November 2026

Status: siap ditinjau untuk persetujuan penerapan manual; BELUM diterapkan pada Production.

## Bukti pemeriksaan Production yang hanya membaca metadata

Koneksi memakai konfigurasi `DATABASE_URL` backend existing, tanpa mengubah `.env` dan tanpa menampilkan password/connection string. Query katalog pada transaksi eksplisit `BEGIN READ ONLY` menghasilkan:

| Metadata | Hasil |
| --- | --- |
| `current_user` / `session_user` backend | `postgres` / `postgres` |
| PostgreSQL Supabase | 17.11 |
| `transaction_read_only` pada pemeriksaan role/UUID | `on` |
| `postgres.rolsuper` | false |
| `postgres.rolbypassrls` | true |
| Backend memiliki `USAGE` schema `public` | true |
| `anon` / `authenticated` | bukan superuser, tidak BYPASSRLS |
| `service_role` | bukan superuser, BYPASSRLS |
| Ketiga role API menjadi member `postgres` | false |
| `public.products.id` / `goods_receipts.id` / `tags.id` | UUID / UUID / UUID |
| `public.orang1_inbound_audit` | belum ada |
| `public.orang1_inbound_audit_id_seq` | belum ada |

Tidak ada query baris bisnis, payload audit, operasi tulis, migrasi, atau pengujian destruktif pada Production. Backup `schema.sql` dan `data.sql` hanya diperiksa keberadaan serta metadata filenya; isinya tidak dibaca. Keberhasilan restore backup tidak diuji dalam pekerjaan ini.

Username pooler dalam connection string tidak dijadikan dasar pemberian grant: role SQL sebenarnya dibuktikan dengan `current_user`. Backend memakai `pg`, sehingga aksesnya melalui role database, bukan API key `service_role`.

## SQL final dan cakupan perubahan

Gunakan seluruh isi `sql/migrations/001_orang1_inbound_audit.sql` sebagai satu transaksi di Supabase SQL Editor setelah persetujuan. File tersebut adalah SQL final yang diuji, termasuk pemeriksaan sebelum dan setelah DDL.

Objek baru persis:

1. Tabel `public.orang1_inbound_audit`.
2. Sequence BIGINT `public.orang1_inbound_audit_id_seq`, dimiliki kolom `audit.id`.
3. Indeks primary key baru `orang1_inbound_audit_pkey`.
4. Indeks pencarian `orang1_inbound_audit_entity_idx (entity_type, entity_id, id)`.

RLS dan ACL hanya diatur pada objek audit baru. Tidak ada tabel lain, extension, role, fungsi/RPC, trigger, enum, default privileges global, PK/FK existing, UUID existing, atau seed yang dibuat ulang/diubah. Blok `DO` hanya berjalan sementara untuk validasi; tidak membuat fungsi persisten.

Sequence dibuat eksplisit sebelum tabel dan diikat dengan `OWNED BY`. Ini setara dengan BIGSERIAL untuk tipe/default/ownership, tetapi menghindari perilaku BIGSERIAL yang dapat memilih nama sequence alternatif saat nama yang diinginkan sudah dipakai. Uji konflik menemukan risiko itu dan SQL final sudah memperbaikinya. Bila sequence/tabel/indeks bernama sama sudah ada, transaksi gagal tanpa mengubah objek lama.

## RLS dan hak akses

- RLS aktif, tanpa policy. Ordinary roles menggunakan default deny.
- Semua hak tabel DAN sequence dicabut dari `PUBLIC`, `anon`, `authenticated`, serta `service_role` pada objek audit baru.
- Pencabutan `service_role` disengaja: role tersebut melewati RLS, tetapi tetap membutuhkan grant objek. Backend yang benar-benar digunakan adalah `postgres`.
- `postgres` diberi `SELECT, INSERT` pada tabel dan `USAGE` pada sequence untuk kebutuhan repository.
- Pemeriksaan akhir menolak deployment jika role API masih mendapat privilege efektif dari inheritance/column grants/sequence grants. Privilege `MAINTAIN` juga diperiksa pada PostgreSQL 17+.
- Tidak ada perubahan membership atau atribut role Production. Bila backend kelak memakai role lain/non-BYPASSRLS, migrasi dan kebijakan akses perlu ditinjau ulang; jangan sekadar memberi grant ke `authenticated` atau menonaktifkan RLS.

`postgres` tetap role administratif/BYPASSRLS dan bisa memiliki hak owner termasuk UPDATE/DELETE. SQL ini tidak mengklaim audit immutable terhadap administrator. Kode repository hanya menambah/membaca event audit. RLS ini membatasi akses database langsung; otorisasi endpoint Fastify mengikuti implementasi autentikasi existing dan tidak diubah di sini.

Dasar dokumentasi: [Supabase RLS dan grants](https://supabase.com/docs/guides/database/postgres/row-level-security), [PostgreSQL RLS](https://www.postgresql.org/docs/16/ddl-rowsecurity.html), [PostgreSQL 17 GRANT](https://www.postgresql.org/docs/17/sql-grant.html). RLS tidak melindungi sequence/TRUNCATE, dan hak sequence tidak otomatis mengikuti hak tabel; karena itu kedua lapisan diperiksa terpisah.

## Kesesuaian repository/service

`repository.ts` sekarang memakai target audit `public.orang1_inbound_audit` secara eksplisit untuk pengecekan keberadaan, INSERT, dan history. Query tidak dapat diarahkan ke tabel audit bayangan hanya dengan mengubah `search_path`. Parameter schema khusus tersedia untuk fixture test terisolasi dan tidak berasal dari request HTTP.

| Kolom | Pemakaian kode | Kesesuaian |
| --- | --- | --- |
| `id BIGINT` | Dibuat sequence, urutan history `ORDER BY id` | Sesuai; tidak mengganti ID bisnis |
| `entity_type TEXT` | `product`, `grn`, `tag` | Sesuai CHECK |
| `entity_id TEXT` | `String(entityId)` | UUID disimpan utuh; bukan cast integer/FK |
| `action TEXT` | CREATE/UPDATE/DELETE/VERIFY/CANCEL/ENCODE_SIMULATION/DEACTIVATE | Sesuai |
| `before_data JSONB` | null untuk create, objek untuk perubahan | Sesuai nullable |
| `after_data JSONB NOT NULL` | Objek hasil perubahan | Sesuai |
| `reason TEXT` | Opsional; diwajibkan service untuk cancel/deactivate | Sesuai |
| `created_at TIMESTAMPTZ` | Default database | Sesuai |

`service.ts` tidak membutuhkan perubahan: ketiga entity type dan payload-nya sudah sesuai. Verifikasi GRN, pembatalan GRN, edit tag, dan penonaktifan tag tetap mewajibkan penyimpanan audit; kegagalan audit me-rollback perubahan status pada transaksi yang sama. Perilaku create dengan audit opsional sebelum tabel tersedia tidak diubah dalam review ini.

## Keamanan terhadap kegagalan

Seluruh DDL, ownership sequence, RLS, grant/revoke, dan pemeriksaan akhir ada di antara BEGIN/COMMIT. Tidak ada DML terhadap data existing. Lock timeout 5 detik dan statement timeout 60 detik hanya berlaku pada transaksi migrasi. Indeks dibuat pada tabel audit baru, bukan tabel bisnis.

Migrasi sengaja tidak memakai `IF NOT EXISTS`: menjalankan ulang akan ditolak dengan aman, agar tabel yang tidak cocok tidak diam-diam digunakan. Jika statement gagal, jangan melanjutkan potongan script atau menjalankan COMMIT terpisah. Jalankan `ROLLBACK;` bila SQL Editor masih menahan transaksi gagal, periksa penyebabnya, lalu minta review ulang. Jangan menghapus objek existing untuk memaksakan migrasi.

## Query verifikasi read-only

File final: `sql/migrations/001_orang1_inbound_audit_verify.sql`.

Jalankan seluruh file sebelum/atau sesudah penerapan manual. Semua pemeriksaan memakai SELECT dalam `BEGIN READ ONLY ... ROLLBACK`; tidak menjalankan `nextval`, `setval`, INSERT, atau membaca payload audit.

Hasil yang diharapkan setelah migrasi:

| Pemeriksaan | Expected |
| --- | --- |
| Tabel dan sequence | Keduanya ada di public |
| RLS | `rls_enabled = true` |
| Policies | Nol baris; default deny |
| Indeks | Primary key dan entity index; valid/ready keduanya true |
| Sequence ownership | `public.orang1_inbound_audit_id_seq` terkait audit.id |
| postgres SELECT/INSERT/sequence USAGE | true / true / true |
| anon/authenticated/service_role, seluruh privilege tabel/kolom/sequence yang ditampilkan | false |
| Client membership ke postgres | false |

Nilai izin bisa NULL sebelum objek ada; ini bukan PASS pascamigrasi. RLS tidak dievaluasi oleh fungsi `has_*_privilege`: fungsi tersebut menunjukkan grant efektif, sedangkan flags/policies diperiksa terpisah. SQL Editor menunjukkan role sesi editor; identitas backend harus diperiksa dari koneksi backend sebagaimana sudah dilakukan pada review ini.

## Pengujian 9 November 2026

| Pengujian | PASS | FAIL | SKIP |
| --- | ---: | ---: | ---: |
| Migrasi/RLS, file SQL final | 15 | 0 | 0 |
| Regresi CRUD memory + PostgreSQL integer/UUID | 109 | 0 | 4 |
| Backend build | PASS | — | — |

Empat SKIP adalah pemeriksaan khusus PostgreSQL pada varian memory; varian PostgreSQL yang relevan lulus. Hasil disimpan pada `tests/evidence/orang1-audit-review-results.txt` dan `tests/evidence/orang1-audit-regression-results.txt`.

Pengujian DDL dilakukan pada PostgreSQL 16 lokal terisolasi dengan role Supabase tiruan, default grants luas maupun tanpa default grants, database disposable, dan UUID dummy. Ini bukan eksekusi migrasi pada PostgreSQL 17 Production. Sintaks yang dipakai kompatibel PostgreSQL 16/17; cabang privilege MAINTAIN khusus versi 17 dikaji terhadap dokumentasi PostgreSQL 17, tetapi tidak diuji dengan DDL di server 17.

Kasus audit yang lulus mencakup footprint hanya empat relasi baru, UUID/FK/seed/default privileges tetap, penolakan seluruh role API, sequence permissions, RLS default deny saat DML tak sengaja diberikan ulang, backend BYPASSRLS non-owner, service dengan UUID, search_path shadowing, rollback status saat audit hilang, fault sebelum COMMIT, pengulangan migrasi, konflik tabel/sequence, inherited table/sequence grants, dan query verifikasi read-only sebelum/sesudah migrasi.

Cara menjalankan suite audit: siapkan cluster QA disposable dengan folder data bernama `digiwms-audit-review-pg-<32 digit hex>`, memakai role admin `postgres`, lalu set hanya pada shell QA:

```powershell
$env:ORANG1_TEST_DATABASE_URL = 'postgresql://postgres@127.0.0.1:55432/postgres'
$env:ORANG1_TEST_ISOLATED = '1'
npm run test:orang1:audit
```

Suite menolak host remote dan cluster dengan nama direktori di luar pola QA tersebut. URL Production di `.env` tidak dipakai untuk operasi test. Suite CRUD existing menggunakan fixture role `anon`, `authenticated`, `service_role` yang disiapkan/dihapus hanya pada cluster QA; SQL migrasi dalam suite CRUD ditempatkan pada schema QA melalui substitusi identifier tepercaya.

## File yang berubah pada review ini

- `sql/migrations/001_orang1_inbound_audit.sql` — SQL manual final yang diperketat.
- `sql/migrations/001_orang1_inbound_audit_verify.sql` — query read-only final.
- `src/modules/orang1-inbound/repository.ts` — schema audit eksplisit, tanpa perubahan query modul lain.
- `tests/orang1.test.ts` — penempatan audit pada schema fixture terisolasi.
- `tests/orang1-audit-migration.test.ts` — 15 kasus migrasi/privilege/rollback.
- `tests/evidence/orang1-audit-*-results.txt` — bukti hasil pengujian.
- `package.json` — script `test:orang1:audit`.
- Dokumen review ini.

Perubahan lokal yang sudah ada sebelum review dipertahankan. `.env`, Docker, frontend, modul Orang 2/3/4, dan backup tidak diubah. Tidak ada commit/push. Cluster QA dihentikan setelah pengujian dan fixture database/schema/role dibersihkan.

Langkah berikutnya: persetujuan pengguna atas file SQL final, kemudian penerapan manual seluruh file melalui Supabase SQL Editor dan menjalankan file verifikasi read-only. Tidak ada penerapan Production otomatis dalam pekerjaan ini.
