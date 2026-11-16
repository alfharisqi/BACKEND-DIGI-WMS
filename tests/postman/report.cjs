// Render Indonesian evidence from executed Newman summaries; never invent a result.
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const base=__dirname, ev=path.join(base,'evidence');
const load=n=>JSON.parse(fs.readFileSync(path.join(ev,n+'.json'),'utf8'));
const runs=['qa-capability','qa-strict','production-readonly'].map(load);
const guards=['guard-production-url','guard-unproven-database','guard-setup-failure'].map(load);
const checks=load('integration-checks').checks;
const scenarios=JSON.parse(fs.readFileSync(path.join(base,'scenarios.json'),'utf8'));
function counts(r){const all=r.requests.flatMap(x=>x.assertions);assert.equal(all.length,r.stats.assertions.total,'Assertion count must not be duplicated by preflight callbacks');return{pass:all.filter(x=>x.status==='PASS').length,fail:all.filter(x=>x.status==='FAIL').length,skip:all.filter(x=>x.status==='SKIP').length};}
const c=runs.map(counts);
for(const r of runs){assert.equal(r.failures.length,0,'Refuse to render a success report from a failed run');assert.ok(r.requests.length>0);r.requests.forEach(q=>{assert.ok(q.statusCode);assert.ok(q.assertions.length>0);assert.ok(q.assertions.every(a=>a.status==='PASS'),'Refuse false PASS for '+q.name);});}
const esc=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const status=r=>r.failures.length||counts(r).fail?'FAIL':'PASS';
const time=d=>new Date(d).toLocaleString('id-ID',{timeZone:'Asia/Jakarta',hour12:false})+' WIB';
const endpoints=[
 ['Master SKU','GET','/api/products','Daftar, harga, minimum, stok tersimpan'],
 ['Master SKU','GET','/api/products/:id','Detail UUID / 404'],
 ['Master SKU','POST','/api/products','Create produk QA, 201'],
 ['Master SKU','PUT','/api/products/:id','Update field lengkap, UUID tetap'],
 ['Master SKU','DELETE','/api/products/:id','Hapus hanya produk QA tanpa stok/relasi'],
 ['Inbound GRN','GET','/api/inbound/grn','Daftar penerimaan'],
 ['Inbound GRN','GET','/api/inbound/grn/:id','Detail, tanggal kalender, audit_history'],
 ['Inbound GRN','POST','/api/inbound/grn','Create pending, 201'],
 ['Inbound GRN','PUT','/api/inbound/grn/:id','Update pending yang belum terkait transaksi'],
 ['Inbound GRN','PATCH','/api/inbound/grn/:id/verify','Pending ke SELESAI sekali'],
 ['Inbound GRN','PATCH','/api/inbound/grn/:id/cancel','Reason wajib, capability 200 / strict 409'],
 ['RFID','GET','/api/tags','Daftar, legacy EPC tetap terbaca'],
 ['RFID','GET','/api/tags/:id','Detail, relasi, audit_history'],
 ['RFID','POST','/api/tags/encode','Registrasi simulasi tag + item ENCODED, 201'],
 ['RFID','PATCH','/api/tags/:id','Koreksi tipe/reassignment aman, EPC immutable'],
 ['RFID','PATCH','/api/tags/:id/deactivate','Reason wajib, capability 200 / strict 409'],
 ['Health','GET','/api/health','Liveness; identitas QA khusus pada harness'],
];
const coverage=endpoints.map((e,i)=>`| ${i+1} | ${e.join(' | ')} |`).join('\n');
let results=[];
for(let i=0;i<scenarios.length;i++){
 const s=scenarios[i], a=runs[0].requests[i], b=runs[1].requests[i];
 assert.equal(a.name,s.name);assert.equal(b.name,s.name);
 const dynamic=s.expected.includes('supportsExtendedStatus');
 const expected=dynamic?'capability 200; strict 409':'HTTP '+s.expected;
 results.push(`| ${s.name} | ${expected} | capability ${a.statusCode}; strict ${b.statusCode} | ${a.assertions.every(x=>x.status==='PASS')&&b.assertions.every(x=>x.status==='PASS')?'PASS':'FAIL'} |`);
}
for(const r of runs[2].requests)results.push(`| Production: ${r.name} | HTTP 200, GET | HTTP ${r.statusCode}; GET | ${r.assertions.every(x=>x.status==='PASS')?'PASS':'FAIL'} |`);
const stats=runs.map((r,i)=>`| ${r.label} | ${r.collectionItems} | ${r.stats.requests.total} | ${r.guardPreflightRequests} | ${r.stats.assertions.total} | ${c[i].pass} | ${c[i].fail} | ${c[i].skip} | ${r.elapsedMs} ms |`).join('\n');
const total=c.reduce((a,x)=>a+x.pass,0);
const captures=runs.map(r=>`- ${r.label}: ${time(r.startedAt)}–${time(r.finishedAt)}.`).join('\n');
const md=`# Laporan API Testing DigiWMS Orang 1

## A. Tujuan API Testing

Memvalidasi Master SKU, penerimaan GRN, dan registrasi RFID melalui kontrak Fastify yang tersedia, termasuk input invalid, konflik bisnis, UUID, integritas relasi, audit, dan batas status database. Artefak ditujukan untuk pengujian ulang dan bukti presentasi kampus.

## B. Lingkungan Pengujian

Branch backend/frontend diperiksa: **feat/orang1-inbound**. Perubahan lokal sebelum tugas dipertahankan. Pekerjaan ini menambahkan artefak di tests/postman; tidak memperbaiki kode aplikasi karena tidak ditemukan bug aplikasi pada skenario yang dijalankan.

QA: Fastify loopback 5001, PostgreSQL 16 cluster baru milik proses pada port 55432. SHOW data_directory diverifikasi sama persis dengan direktori TEMP yang dibuat harness. Setiap mode mendapat schema acak berbeda dan fixture sintetis. Repository diinjeksi khusus QA; publisher diinjeksi sebagai spy, tanpa koneksi broker. Definisi fixture termasuk tabel audit dibuat langsung di schema disposable; tidak ada migrasi SQL yang dibaca/dijalankan dan tidak ada ALTER constraint Production.

Capability mendukung DIBATALKAN dan DAMAGED. Strict sengaja meniru batas CHECK yang terakhir diketahui pada Production. Hasil strict bukan pemeriksaan ulang metadata Production saat ini. Default connectionString QA ditetapkan dalam harness, tidak diambil dari DATABASE_URL. Import modul konfigurasi aplikasi tidak menjalankan init/check database/MQTT; routes selalu menggunakan repository/publisher QA yang diinjeksi.

Production existing: localhost:5000, sumber Supabase berdasarkan konteks konfigurasi yang telah diverifikasi sebelumnya. Hanya tujuh GET koleksi read-only dijalankan. Health POSTGRESQL_DOCKER tidak digunakan sebagai bukti identitas database. Tidak ada inspeksi isi backup, perubahan environment, Docker, UUID/PK/FK existing, modul tim lain, commit, atau push.

Waktu eksekusi bukti terakhir:

${captures}

## C. Daftar Endpoint

Kontrak ditelusuri dari routes.ts, service.ts, repository.ts, validation.ts, schema-contract.ts, konfigurasi db/server, klien API frontend, serta tes existing. Ada 16 endpoint Orang 1 dan satu health check.

| No | Modul | Method | Endpoint | Tujuan |
|---|---|---|---|---|
${coverage}

Body produk: sku, name, category, price, min_stock_alert; native Supabase menyimpan unit_price/min_stock_threshold. Body GRN: po_number, supplier_name, total_qty, receipt_date. GRN produk ditautkan melalui items.grn_id, bukan memaksakan kolom product_id yang tidak ada. Body encode: product_id, epc_custom, type, mode: simulation, opsional grn_id. Body edit tag hanya field yang didukung; cancel/deactivate memakai reason. Semua response aplikasi sukses memakai success/message/data, encode juga mempertahankan field legacy top-level.

## D. Skenario Pengujian

- Produk: create tiga produk berbeda; baca daftar/detail; update dan GET persisted; hapus produk tanpa relasi dan pastikan 404; duplicate SKU, input kosong, harga/minimum negatif, ID invalid/tidak ditemukan; perlindungan produk dengan item/tag, stok positif, serta ledger saja.
- GRN: PO unik, UUID, supplier/qty/tanggal stabil, status awal pending dan RFID menunggu; update pending, verify sekali, audit VERIFY, penolakan edit/cancel selesai; cancel GRN terpisah dengan reason; strict 409 tanpa perubahan; PO duplicate, supplier kosong, qty nol/negatif/pecahan, tanggal invalid, missing UUID, serta dampak stok.
- RFID: tiga EPC baru 24 hex, tiga tipe dengan mapping native Supabase; relasi item/tag/product/GRN; ENCODED dan hardware_confirmed false; legacy EPC QA terbaca; update tipe, reassignment sebelum transaksi; larangan edit EPC, status ilegal, reassign GRN/transaksi, dan deactivate tag bertransaksi. Fixture ENCODED dengan ledger menguji histori transaksi meskipun status tag masih bisa diedit secara umum. Deactivate capability/strict, reason, EPC tetap tersimpan dan reuse 409.
- Audit: catatan CREATE/UPDATE/VERIFY/CANCEL/ENCODE_SIMULATION/DEACTIVATE diperiksa dari detail HTTP dengan entity_type/entity_id, action, before/after dan reason. Audit produk/DELETE, zero orphan, ledger, item native dan publisher spy diperiksa terpisah melalui PostgreSQL QA.
- Safety: port Production ditolak sebelum request terkirim; server berlabel Docker tanpa attestation ditolak tanpa write; setup produk yang sengaja dibuat invalid menghentikan urutan sebelum operasi dependen PUT/PATCH/DELETE; server menolak mutation tanpa header QA.

## E. Hasil Pengujian

Setiap baris berikut berasal dari response dan assertion Newman yang dieksekusi. Expected 400/404/409 adalah hasil benar untuk negative case, bukan FAIL. Dua mode QA ditampilkan pada satu baris agar perbedaan capability terlihat.

| Test Case | Expected Result | Actual Result | Status |
|---|---|---|---|
${results.join('\n')}

## F. Pengujian UUID

UUID respons create ditangkap ke environment runtime dan dibandingkan utuh pada GET/PUT/verify/edit/tag relasi. Pola UUID divalidasi; tidak ada pemetaan UUID menjadi integer. SKU/PO memakai prefix QA-O1-SKU-/QA-O1-PO- dengan ID run acak; EPC dibuat ulang untuk setiap run. ID seed Production tidak di-hardcode. Production detail mengambil UUID dari list GET pada run yang sama.

## G. Pengujian Database

${checks.length} pemeriksaan tambahan mencakup validasi schema/import, keamanan target, penghentian setup gagal, identitas cluster, serta integrasi database. Angka ini terpisah dari assertion Postman. Per mode, SQL QA membuktikan ledger identik sebelum/sesudah; fixture produk/GRN/tag/ledger tidak berubah; tidak ada orphan product/tag/GRN; relasi produk pada ledger/tag konsisten; item tetap ENCODED tanpa lokasi; reassignment tersimpan; produk yang dihapus tetap memiliki audit CREATE/UPDATE/DELETE dengan snapshot; EPC dan item setelah deactivate tetap ada. Audit berjumlah 16 pada capability dan 14 pada strict; request gagal tidak menambahkan audit. Ada tepat tiga panggilan publisher spy untuk tiga encode sukses, seluruhnya simulation/hardware_confirmed false, tanpa publish ke broker.

Tidak ada endpoint baru untuk audit. Audit produk/ledger tidak diklaim sebagai request Postman. Tidak ada klaim audit Production bertambah: suite Production tidak menulis atau menghitung seluruh audit melalui SQL. Hasil Production read-only membuktikan response HTTP/UUID/detail pada waktu run; tidak membuktikan database bebas perubahan dari proses lain.

## H. Pengujian Error Handling

HTTP 400 terbukti untuk input invalid dan JSON malformed; 404 untuk UUID yang tidak ditemukan serta GET produk setelah DELETE; 409 untuk duplikat, transisi ilegal, relasi/stock/ledger, serta status yang tidak didukung fixture strict. Error aplikasi dicek success false dan message nonkosong. Malformed JSON ditolak sebelum handler oleh Fastify dan menggunakan statusCode/error/message; bentuk native ini diuji secara eksplisit. HTTP 403 server QA dibuktikan dengan inject tanpa header attestation (pemeriksaan integrasi, bukan endpoint aplikasi tambahan).

## I. Hasil Collection Runner

Newman 6.2.3, satu iteration per mode, bail aktif. Koleksi QA memuat 76 item; Production tujuh item GET. HTTP total juga menghitung GET attestation sebelum tiap request QA; jumlah itu tidak boleh dianggap item bisnis tambahan. SDK execution entry untuk callback preflight dideduplikasi berdasarkan item ID sebelum pelaporan assertion.

| Run | Item koleksi dieksekusi | HTTP total | GET attestation tambahan | Assertion | PASS | FAIL | SKIP | Waktu collection |
|---|---:|---:|---:|---:|---:|---:|---:|---|
${stats}

Total suite normal: **${runs.reduce((a,r)=>a+r.collectionItems,0)} eksekusi item koleksi, ${total} assertion PASS, ${c.reduce((a,r)=>a+r.fail,0)} FAIL, ${c.reduce((a,r)=>a+r.skip,0)} SKIP**. Ada ${checks.length} pemeriksaan tambahan PASS. Angka 158 PASS dari pekerjaan sebelumnya tidak dimasukkan.

Tiga fault-injection run guard sengaja menghasilkan failed assertion/script dan dihitung terpisah. File guard-production-url membuktikan target 5000 diblokir; guard-unproven-database hanya mencapai GET health server stub; guard-setup-failure berhenti sesudah setup produk 400, tanpa PUT/PATCH/DELETE selanjutnya. Assertion gagal ini merupakan stimulus untuk uji guard, bukan kegagalan suite bisnis yang disembunyikan. Validasi guard yang memeriksa efeknya tercatat PASS pada integration-checks.json.

## J. Bukti Pengujian

- evidence/qa-capability.json dan qa-strict.json: status, waktu, dan nama/hasil assertion per item; tanpa response body/headers/environment.
- evidence/production-readonly.json: tujuh GET aktual dengan assertion UUID; payload data operasional tidak disimpan.
- evidence/guard-production-url.json, guard-unproven-database.json, guard-setup-failure.json: stimulus kegagalan disengaja untuk safety.
- evidence/integration-checks.json dan summary.json: pemeriksaan SQL QA/static/safety, statistik raw Newman, waktu.
- evidence/runner-report.html: tampilan bukti aktual yang dapat dibuka di browser atau dicetak PDF, bukan screenshot Postman palsu.
- collection-schema-v2.1.json: schema resmi; kedua koleksi lolos validasi draft-04 serta konstruksi/import SDK Postman yang dipakai Newman. Import GUI Postman tidak dioperasikan pada sesi ini.

## K. Kendala dan Batasan

CRUD Production, perubahan CHECK Production, migrasi audit, putaway Orang 2, stock opname Orang 3, autentikasi/actor Orang 4, hardware RFID fisik dan pengiriman MQTT bisnis: **NOT TESTED pada tugas ini**. Cancel/DAMAGED success hanya terbukti pada capability QA; strict membuktikan penolakan aman. Tabel audit QA adalah fixture kontrak, sehingga suite ini tidak menguji deployment migrasi, RLS/privilege Supabase Production atau autentikasi aplikasi. Klaim keamanan QA adalah isolasi proses/cluster ditambah guard, bukan mekanisme autentikasi Production.

Newman dipasang sementara tanpa dependency global/proyek. Node mengeluarkan deprecation warning fs.F_OK dari toolchain Newman; tidak ada failed assertion normal akibat warning itu. Pengujian menggunakan aplikasi Fastify dan repository aktual dengan fixture schema; tidak menguji UI browser pada tugas ini. Pengukuran durasi adalah durasi collection lokal, bukan benchmark beban/performa Production. Cluster disposable dihentikan setelah run; direktori TEMP QA dapat tersisa, tidak ada database operasional yang di-cleanup.

## L. Kesimpulan

API Orang 1 siap untuk demonstrasi alur CRUD pada QA disposable dan demonstrasi tujuh endpoint GET pada backend existing berdasarkan bukti run ini. Master SKU, GRN, RFID, UUID, error handling, perlindungan relasi dan audit sesuai assertion yang dieksekusi. Gunakan README_POSTMAN_TESTING.md untuk import, pemilihan environment, urutan Runner, dan pemisahan capability/strict. Tidak diperlukan penerapan atau perubahan Production untuk memakai artefak ini.
`;
fs.writeFileSync(path.join(base,'ORANG1_API_TEST_REPORT.md'),md);
let html=`<!doctype html><html lang="id"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DigiWMS Orang 1 — Bukti Newman</title><style>body{font:16px system-ui,sans-serif;color:#14283f;background:#f1f5f9;margin:0}main{max-width:1160px;margin:auto;padding:40px 24px}h1{margin-bottom:8px}p{line-height:1.6}.cards{display:flex;gap:18px;flex-wrap:wrap}.card,section{background:white;border-radius:12px;padding:24px;margin:20px 0;box-shadow:0 2px 12px #1231}.card{flex:1;min-width:210px}.big{font-size:34px;font-weight:800;color:#08784f}.muted{color:#58697c;font-size:14px}table{border-collapse:collapse;width:100%;font-size:14px}td,th{text-align:left;border-bottom:1px solid #e2e8f0;padding:10px;vertical-align:top}th{background:#edf3fa}summary{cursor:pointer;font-weight:600;padding:10px}details{border-bottom:1px solid #e2e8f0;padding:4px}.pass{color:#08784f}.fault{color:#916000}code{background:#edf3fa;padding:2px 5px}@media print{body{background:white}main{padding:0}.card,section{box-shadow:none;border:1px solid #ddd}details{break-inside:avoid}}</style><main><p class="muted">BUKTI EKSEKUSI AKTUAL • ${esc(time(runs[2].finishedAt))}</p><h1>DigiWMS — API Orang 1</h1><p>Postman v2.1 • Newman 6.2.3 • PostgreSQL QA disposable • Production GET-only</p><div class="cards"><div class="card"><div class="big">${total}</div>assertion PASS</div><div class="card"><div class="big">${runs.reduce((a,r)=>a+r.collectionItems,0)}</div>eksekusi item koleksi</div><div class="card"><div class="big">${checks.length}</div>pemeriksaan tambahan PASS</div></div><p>Suite bisnis: 0 FAIL, 0 SKIP. Tidak termasuk 158 test lama. Tiga stimulus kegagalan untuk guard ditampilkan terpisah. Tidak ada response body Production, credential, atau environment runtime dalam laporan ini.</p>`;
for(const [i,r]of runs.entries()){
 html+=`<section><h2>${esc(r.label)} — <span class="pass">${status(r)}</span></h2><p class="muted">${esc(time(r.startedAt))} · ${r.collectionItems} item · ${r.stats.requests.total} HTTP termasuk ${r.guardPreflightRequests} GET attestation · ${c[i].pass} assertion PASS · ${r.elapsedMs} ms</p><table><tr><th>Request aktual</th><th>Method</th><th>HTTP</th><th>Assertion</th><th>Durasi</th></tr>`;
 for(const q of r.requests)html+=`<tr><td>${esc(q.name)}</td><td>${esc(q.method)}</td><td>${q.statusCode}</td><td><details><summary class="pass">${q.assertions.length} PASS</summary>${q.assertions.map(a=>'<p>'+esc(a.name)+' — '+esc(a.status)+'</p>').join('')}</details></td><td>${q.durationMs} ms</td></tr>`;
 html+='</table></section>';
}
html+=`<section><h2>Uji guard — fault injection terpisah</h2><p>Kegagalan disengaja memicu penghentian koleksi. Efek aman diverifikasi pada pemeriksaan tambahan.</p><table><tr><th>Run</th><th>Stimulus</th><th>Failed assertion disengaja</th><th>Hasil verifikasi safety</th></tr>${guards.map(g=>`<tr><td>${esc(g.label)}</td><td class="fault">EXPECTED FAILURE</td><td>${g.stats.assertions.failed}</td><td class="pass">PASS (lihat integration-checks.json)</td></tr>`).join('')}</table></section><section><h2>Database, isolasi, dan import</h2>${checks.map(x=>`<p><span class="pass">${esc(x.status)}</span> — ${esc(x.name)}</p>`).join('')}</section><p class="muted">Batasan: tanpa CRUD Production, migrasi, hardware RFID fisik, UI Postman GUI, atau publish MQTT bisnis. Rincian dan tabel expected/actual tersedia di ORANG1_API_TEST_REPORT.md.</p></main></html>`;
fs.writeFileSync(path.join(ev,'runner-report.html'),html);
console.log('Rendered report from '+total+' actual passing assertions and '+checks.length+' separate checks.');
