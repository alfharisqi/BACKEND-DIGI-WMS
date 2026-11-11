/* Generates reviewable Postman v2.1 artifacts; never contacts an API/database. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = __dirname;
const schema = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';
const ev = (listen, code) => ({ listen, script: { type: 'text/javascript', exec: code.split('\n') } });
const common = `const j = pm.response.json(), d = j.data;
const V = k => pm.environment.get(k);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function T(n,f) { pm.test(n,()=>{try{f();}catch(e){pm.environment.set('qaFailed','true');pm.execution.setNextRequest(null);throw e;}}); }
function eq(n,a,b){T(n,()=>pm.expect(a).to.eql(b));}
function id(n,v){T(n,()=>pm.expect(v).to.match(uuid));}
function capture(k,v){id(k+' UUID',v);if(uuid.test(v))pm.environment.set(k,v);}
function history(action,entity,k){T('audit '+action+' UUID dan snapshot',()=>{const a=d.audit_history.find(x=>x.action===action);pm.expect(a,'audit '+action).to.be.an('object');pm.expect(a.entity_type).to.eql(entity);pm.expect(a.entity_id).to.eql(V(k));pm.expect(a.after_data).to.be.an('object');pm.expect(a.created_at).to.be.a('string');if(action!=='CREATE'&&action!=='ENCODE_SIMULATION')pm.expect(a.before_data).to.be.an('object');});}
`;
const qaGuard = `// Safe even on runtimes lacking skipRequest: fail closed by replacing the URL first.
function deny(message){pm.request.url.update('http://127.0.0.1:1/QA-BLOCKED');pm.environment.set('qaFailed','true');pm.execution.setNextRequest(null);pm.test('QA safety guard: '+message,()=>{throw new Error(message);});if(pm.execution.skipRequest)pm.execution.skipRequest();throw new Error(message);}
const base=pm.environment.get('baseUrl');
if(!/^http:\\/\\/(127\\.0\\.0\\.1|localhost):5001$/.test(base||''))deny('QA requires dedicated loopback port 5001; port 5000 is Production.');
if(pm.info.requestName==='01.00 — Mulai run QA'){
 ['productId','productIdLinked','productIdOther','grnId','grnIdCancel','tagId','tagIdReassign','tagIdDeactivate','itemId','qaNonce'].forEach(k=>pm.environment.unset(k));
 pm.environment.set('qaFailed','false');
 const run=pm.variables.replaceIn('{{$guid}}').replace(/-/g,'');
 pm.environment.set('qaRunId',run);pm.environment.set('qaSku','QA-O1-SKU-'+run);pm.environment.set('qaPoNumber','QA-O1-PO-'+run);
 ['epc','epcReassign','epcDeactivate'].forEach(k=>pm.environment.set(k,pm.variables.replaceIn('{{$guid}}').replace(/-/g,'').slice(0,24).toUpperCase()));
 pm.environment.set('missingId',pm.variables.replaceIn('{{$guid}}'));
}
if(pm.environment.get('qaFailed')==='true'||!pm.environment.get('qaRunId'))deny('Setup failed or run not started. Run the collection from 01.00.');
if(/{{[^}]+}}/.test(pm.variables.replaceIn(pm.request.url.toString())) || /{{[^}]+}}/.test(pm.variables.replaceIn(pm.request.body&&pm.request.body.raw||'')))deny('Unresolved dependency variable.');
pm.sendRequest(base+'/api/health',(err,res)=>{
 if(err||res.code!==200) return deny('QA attestation unavailable.');
 let h;try{h=res.json();}catch(e){return deny('Invalid QA health JSON.');}
 if(!h.qa||h.qa.kind!=='digiwms-postman-disposable-pg'||h.qa.isolated!==true||h.qa.mqtt!=='spy'||!/^orang1_postman_[a-f0-9]{32}$/.test(h.qa.schema)||!h.qa.nonce)return deny('Target has no disposable PostgreSQL proof.');
 const old=pm.environment.get('qaNonce');if(old&&old!==h.qa.nonce)return deny('QA process changed during run.');
 pm.environment.set('qaNonce',h.qa.nonce);pm.environment.set('supportsExtendedStatus',String(h.qa.extended));
 Object.keys(h.qa.fixtures).forEach(k=>pm.environment.set(k,h.qa.fixtures[k]));
 pm.request.headers.upsert({key:'X-Orang1-QA-Nonce',value:h.qa.nonce});
 pm.request.headers.upsert({key:'X-Orang1-QA-Run',value:pm.environment.get('qaRunId')});
});`;
const folders = ['01 — MASTER SKU / PRODUCTS','02 — INBOUND GRN','03 — RFID TAGGING / ENCODING','04 — AUDIT TRAIL & DATA INTEGRITY','05 — HEALTH CHECK & NEGATIVE TESTS'].map(name=>({name,item:[]}));
let specs=[];
function add(f,name,method,url,status,body,check='',options={}){
 const expected=typeof status==='string'?status:String(status);
 const script=common+`eq('HTTP '+(${expected}),pm.response.code,${expected});\n`+(options.health?'':options.native?`eq('Native Fastify error status',j.statusCode,400);T('Native message',()=>pm.expect(j.message).to.be.a('string').and.not.empty);\n`:`eq('success envelope',j.success,(${expected})<400);\n`)+`T('JSON object',()=>pm.expect(j).to.be.an('object'));\n`+((typeof status==='number'&&status>=400)||options.error?`T('Error message',()=>pm.expect(j.message).to.be.a('string').and.not.empty);\n`:'')+check;
 const req={name,request:{method,header:[{key:'Content-Type',value:'application/json'}],url:'{{baseUrl}}'+url,description:options.description||'QA disposable PostgreSQL saja. Jalankan dari awal koleksi; assertion gagal menghentikan urutan.'},event:[ev('test',script)]};
 if(body!==undefined)req.request.body={mode:'raw',raw:typeof body==='string'?body:JSON.stringify(body,null,2),options:{raw:{language:'json'}}};
 folders[f].item.push(req);specs.push({folder:folders[f].name,name,method,url,expected:expected});
}
const product=(s='{{qaSku}}',name='Produk Sintetis QA')=>({sku:s,name,category:'QA Orang 1',price:12500.5,min_stock_alert:2});
const grn=(po='{{qaPoNumber}}',extra={})=>({po_number:po,supplier_name:'Supplier Sintetis QA',total_qty:3,receipt_date:'2026-11-05',...extra});
const enc=(extra={})=>({product_id:'{{productIdLinked}}',epc_custom:'{{epc}}',type:'STANDARD_LABEL',mode:'simulation',...extra});
const reason='QA Orang 1: pemeriksaan alasan dan riwayat';
const ext=`V('supportsExtendedStatus')==='true'`;
add(0,'01.00 — Mulai run QA','GET','/api/health',200,undefined,`eq('Disposable database',j.qa.isolated,true);eq('MQTT spy',j.qa.mqtt,'spy');`,{health:true});
add(0,'01.01 — CREATE produk tanpa relasi','POST','/api/products',201,product(),`capture('productId',d.id);eq('SKU',d.sku,V('qaSku'));eq('Nama',d.name,'Produk Sintetis QA');eq('Harga',Number(d.unit_price),12500.5);eq('Minimum stok',d.min_stock_threshold,2);`);
add(0,'01.02 — CREATE produk untuk relasi','POST','/api/products',201,product('{{qaSku}}-L'),`capture('productIdLinked',d.id);`);
add(0,'01.03 — CREATE produk reassignment','POST','/api/products',201,product('{{qaSku}}-R'),`capture('productIdOther',d.id);`);
add(0,'01.04 — READ daftar produk','GET','/api/products',200,undefined,`T('Daftar dan field produk',()=>{pm.expect(d).to.be.an('array');const p=d.find(x=>x.id===V('productId'));pm.expect(p.sku).to.eql(V('qaSku'));pm.expect(Number(p.price)).to.eql(12500.5);pm.expect(p.min_stock_alert).to.eql(2);pm.expect(p.current_stock).to.eql(0);});`);
add(0,'01.05 — READ detail produk','GET','/api/products/{{productId}}',200,undefined,`id('UUID',d.id);eq('ID utuh',d.id,V('productId'));eq('SKU',d.sku,V('qaSku'));`);
add(0,'01.06 — UPDATE produk','PUT','/api/products/{{productId}}',200,product('{{qaSku}}','Produk QA Diperbarui'),`eq('UUID tidak berubah',d.id,V('productId'));eq('Nama',d.name,'Produk QA Diperbarui');eq('SKU konsisten',d.sku,V('qaSku'));`);
add(0,'01.07 — READ update persisted','GET','/api/products/{{productId}}',200,undefined,`eq('Nama tersimpan',d.name,'Produk QA Diperbarui');eq('UUID',d.id,V('productId'));`);
for(const [name,patch] of [['SKU kosong',{sku:''}],['Nama kosong',{name:''}],['Harga negatif',{price:-1}],['Minimum stok negatif',{min_stock_alert:-1}]])add(0,'01.N — '+name,'POST','/api/products',400,{...product(),...patch});
add(0,'01.N — SKU duplikat','POST','/api/products',409,product());
add(0,'01.N — UUID tidak ditemukan','GET','/api/products/{{missingId}}',404);
add(0,'01.N — Format ID salah','GET','/api/products/bukan-id',400);
add(0,'01.08 — DELETE hanya produk QA tanpa relasi','DELETE','/api/products/{{productId}}',200,undefined,`eq('UUID terhapus',d.id,V('productId'));`);
add(0,'01.09 — GET setelah DELETE','GET','/api/products/{{productId}}',404);
add(1,'02.01 — CREATE GRN verifikasi','POST','/api/inbound/grn',201,grn(),`capture('grnId',d.id);eq('PO',d.po_number,V('qaPoNumber'));eq('Supplier',d.supplier_name,'Supplier Sintetis QA');eq('Qty',d.total_qty,3);eq('Tanggal kalender',d.receipt_date,'2026-11-05');eq('Status awal',d.status,'MENUNGGU_VERIFIKASI');eq('RFID menunggu',d.rfid_tagging_status,'MENUNGGU_TAGGING');`);
add(1,'02.02 — CREATE GRN pembatalan terpisah','POST','/api/inbound/grn',201,grn('{{qaPoNumber}}-C'),`capture('grnIdCancel',d.id);T('Fixture berbeda',()=>pm.expect(d.id).not.eql(V('grnId')));`);
add(1,'02.03 — READ daftar GRN','GET','/api/inbound/grn',200,undefined,`T('Daftar',()=>pm.expect(d).to.be.an('array'));`);
add(1,'02.04 — READ detail GRN','GET','/api/inbound/grn/{{grnId}}',200,undefined,`eq('UUID',d.id,V('grnId'));eq('Tanggal stabil',d.receipt_date,'2026-11-05');eq('PO',d.po_number,V('qaPoNumber'));eq('Supplier',d.supplier_name,'Supplier Sintetis QA');history('CREATE','grn','grnId');`);
add(1,'02.05 — UPDATE pending GRN','PUT','/api/inbound/grn/{{grnId}}',200,grn('{{qaPoNumber}}',{supplier_name:'Supplier QA Diperbarui',total_qty:4}),`eq('ID tetap',d.id,V('grnId'));eq('Supplier',d.supplier_name,'Supplier QA Diperbarui');eq('Qty',d.total_qty,4);`);
add(1,'02.06 — READ GRN updated','GET','/api/inbound/grn/{{grnId}}',200,undefined,`eq('Supplier tersimpan',d.supplier_name,'Supplier QA Diperbarui');eq('Qty tersimpan',d.total_qty,4);eq('Tanggal stabil',d.receipt_date,'2026-11-05');history('UPDATE','grn','grnId');`);
add(1,'02.07 — VERIFY GRN','PATCH','/api/inbound/grn/{{grnId}}/verify',200,{},`eq('SELESAI',d.status,'SELESAI');T('verified_at',()=>pm.expect(Number.isNaN(Date.parse(d.verified_at))).to.eql(false));eq('RFID tidak selesai otomatis',d.rfid_tagging_status,'MENUNGGU_TAGGING');`);
add(1,'02.N — Verifikasi ulang','PATCH','/api/inbound/grn/{{grnId}}/verify',409,{});
add(1,'02.N — Edit GRN selesai','PUT','/api/inbound/grn/{{grnId}}',409,grn());
add(1,'02.N — Cancel GRN selesai ditolak','PATCH','/api/inbound/grn/{{grnId}}/cancel',409,{reason});
add(1,'02.N — Pembatalan wajib alasan','PATCH','/api/inbound/grn/{{grnIdCancel}}/cancel',400,{});
add(1,'02.08 — CANCEL atau penolakan constraint','PATCH','/api/inbound/grn/{{grnIdCancel}}/cancel',`(${ext}?200:409)`,{reason},`if(${ext})eq('DIBATALKAN',d.status,'DIBATALKAN');else T('Constraint ditolak jelas',()=>pm.expect(j.message).to.include('belum mendukung'));`);
add(1,'02.N — Pembatalan ulang ditolak','PATCH','/api/inbound/grn/{{grnIdCancel}}/cancel',409,{reason});
add(1,'02.N — GRN berdampak stok fixture QA','PATCH','/api/inbound/grn/{{fixtureGrnId}}/cancel',409,{reason});
for(const [name,patch] of [['Supplier kosong',{supplier_name:''}],['Qty nol',{total_qty:0}],['Qty negatif',{total_qty:-1}],['Qty pecahan',{total_qty:1.5}],['Tanggal invalid',{receipt_date:'2026-02-30'}]])add(1,'02.N — '+name,'POST','/api/inbound/grn',400,grn('{{qaPoNumber}}-INVALID',patch));
add(1,'02.N — PO duplikat','POST','/api/inbound/grn',409,grn());
add(1,'02.N — GRN tidak ditemukan','GET','/api/inbound/grn/{{missingId}}',404);
add(2,'03.01 — ENCODE label biasa dan item GRN','POST','/api/tags/encode',201,enc({grn_id:'{{grnId}}'}),`capture('tagId',d.tag.id);capture('itemId',d.item.id);eq('EPC',d.tag.epc,V('epc'));eq('Produk',d.item.product_id,V('productIdLinked'));eq('Tag relasi',d.item.tag_id,d.tag.id);eq('GRN relasi',d.item.grn_id,V('grnId'));eq('Tag ENCODED',d.tag.status,'ENCODED');eq('Item ENCODED',d.item.status,'ENCODED');eq('Native label',d.tag.tag_type,'Label Biasa (UHF)');eq('Mode',d.mode,'simulation');eq('Tanpa konfirmasi fisik',d.hardware_confirmed,false);`);
add(2,'03.02 — ENCODE ON_METAL untuk reassignment','POST','/api/tags/encode',201,enc({epc_custom:'{{epcReassign}}',type:'ON_METAL'}),`capture('tagIdReassign',d.tag.id);eq('Native ON_METAL',d.tag.tag_type,'On-Metal (Logam/Cairan)');`);
add(2,'03.03 — ENCODE HARD_TAG untuk deactivate','POST','/api/tags/encode',201,enc({epc_custom:'{{epcDeactivate}}',type:'HARD_TAG'}),`capture('tagIdDeactivate',d.tag.id);eq('Native HARD_TAG',d.tag.tag_type,'Hard Tag (Aset)');`);
add(2,'03.04 — READ daftar RFID termasuk legacy QA','GET','/api/tags',200,undefined,`T('Legacy EPC tetap terbaca',()=>{pm.expect(d).to.be.an('array');const t=d.find(x=>x.id===V('fixtureTagId'));pm.expect(t.epc).to.eql('QA-LEGACY-EPC');});`);
add(2,'03.05 — READ detail RFID','GET','/api/tags/{{tagId}}',200,undefined,`eq('ID',d.id,V('tagId'));eq('EPC',d.epc,V('epc'));eq('Produk',d.product_id,V('productIdLinked'));eq('SKU',d.sku,V('qaSku')+'-L');eq('Nama produk',d.product_name,'Produk Sintetis QA');eq('Type API',d.type,'STANDARD_LABEL');eq('Status',d.status,'ENCODED');eq('Item UUID',d.item_id,V('itemId'));history('ENCODE_SIMULATION','tag','tagId');`);
add(2,'03.06 — UPDATE tipe RFID','PATCH','/api/tags/{{tagId}}',200,{type:'ON_METAL'},`eq('ID tetap',d.id,V('tagId'));eq('Native type',d.tag_type,'On-Metal (Logam/Cairan)');eq('EPC tetap',d.epc,V('epc'));`);
add(2,'03.07 — REASSIGN tag tanpa transaksi','PATCH','/api/tags/{{tagIdReassign}}',200,{product_id:'{{productIdOther}}'},`eq('UUID tetap',d.id,V('tagIdReassign'));`);
add(2,'03.08 — READ reassignment persisted','GET','/api/tags/{{tagIdReassign}}',200,undefined,`eq('Relasi baru',d.product_id,V('productIdOther'));eq('EPC tetap',d.epc,V('epcReassign'));history('UPDATE','tag','tagIdReassign');T('Audit relasi before/after',()=>{const a=d.audit_history.find(x=>x.action==='UPDATE');pm.expect(a.before_data.product_id).to.eql(V('productIdLinked'));pm.expect(a.after_data.product_id).to.eql(V('productIdOther'));});`);
add(2,'03.N — EPC immutable','PATCH','/api/tags/{{tagId}}',409,{epc:'{{epcReassign}}'});
add(2,'03.N — Transisi IN_STOCK ilegal','PATCH','/api/tags/{{tagId}}',409,{status:'IN_STOCK'});
add(2,'03.N — Reassign tag GRN ditolak','PATCH','/api/tags/{{tagId}}',409,{product_id:'{{productIdOther}}'});
add(2,'03.N — Reassign tag transaksi fixture QA ditolak','PATCH','/api/tags/{{fixtureTagId}}',409,{product_id:'{{productIdOther}}'});
add(2,'03.N — Deactivate tag transaksi ditolak','PATCH','/api/tags/{{fixtureTagId}}/deactivate',409,{reason});
add(2,'03.N — Reassign ENCODED dengan ledger ditolak','PATCH','/api/tags/{{fixtureTransactionTagId}}',409,{product_id:'{{productIdOther}}'});
add(2,'03.N — Deactivate ENCODED dengan ledger ditolak','PATCH','/api/tags/{{fixtureTransactionTagId}}/deactivate',409,{reason});
add(2,'03.N — Deactivate wajib alasan','PATCH','/api/tags/{{tagIdDeactivate}}/deactivate',400,{});
add(2,'03.09 — DEACTIVATE atau penolakan constraint','PATCH','/api/tags/{{tagIdDeactivate}}/deactivate',`(${ext}?200:409)`,{reason},`if(${ext})eq('DAMAGED',d.status,'DAMAGED');else T('Constraint ditolak jelas',()=>pm.expect(j.message).to.include('belum mendukung'));`);
add(2,'03.N — EPC tetap tidak boleh digunakan ulang','POST','/api/tags/encode',409,enc({epc_custom:'{{epcDeactivate}}'}));
for(const [name,patch,status] of [['EPC pendek',{epc_custom:'1234'},400],['EPC lebih 96 bit',{epc_custom:'A'.repeat(26)},400],['EPC non-hex',{epc_custom:'Z'.repeat(24)},400],['EPC duplikat',{},409],['Produk tidak ditemukan',{product_id:'{{missingId}}',epc_custom:'{{epcUnused}}'},404],['Type invalid',{type:'INVALID'},400],['Hardware belum didukung',{mode:'hardware'},409]]){
 // Unique non-existing EPC for missing-product test, generated in its pre-request.
 add(2,'03.N — '+name,'POST','/api/tags/encode',status,enc(patch));
}
// epcUnused must exist before collection-level dependency validation.
const guard = qaGuard.replace("['epc','epcReassign','epcDeactivate']","['epc','epcReassign','epcDeactivate','epcUnused']");
add(2,'03.N — Tag tidak ditemukan','GET','/api/tags/{{missingId}}',404);
add(3,'04.01 — Audit CREATE UPDATE VERIFY GRN','GET','/api/inbound/grn/{{grnId}}',200,undefined,`history('CREATE','grn','grnId');history('UPDATE','grn','grnId');history('VERIFY','grn','grnId');T('Before/after VERIFY',()=>{const a=d.audit_history.find(x=>x.action==='VERIFY');pm.expect(a.before_data.status).to.eql('MENUNGGU_VERIFIKASI');pm.expect(a.after_data.status).to.eql('SELESAI');pm.expect(d.audit_history.filter(x=>x.action==='VERIFY')).to.have.length(1);});eq('Tanggal tidak bergeser',d.receipt_date,'2026-11-05');`);
add(3,'04.02 — Audit CANCEL dan data tidak dihapus','GET','/api/inbound/grn/{{grnIdCancel}}',200,undefined,`eq('UUID dipertahankan',d.id,V('grnIdCancel'));eq('Status sesuai capability',d.status,${ext}?'DIBATALKAN':'MENUNGGU_VERIFIKASI');if(${ext}){history('CANCEL','grn','grnIdCancel');T('Alasan dan snapshot CANCEL',()=>{const a=d.audit_history.find(x=>x.action==='CANCEL');pm.expect(a.reason).to.eql(${JSON.stringify(reason)});pm.expect(a.before_data.status).to.eql('MENUNGGU_VERIFIKASI');pm.expect(a.after_data.status).to.eql('DIBATALKAN');});}else eq('Tidak ada audit CANCEL palsu',d.audit_history.filter(x=>x.action==='CANCEL').length,0);`);
add(3,'04.03 — Audit ENCODE UPDATE RFID','GET','/api/tags/{{tagId}}',200,undefined,`history('ENCODE_SIMULATION','tag','tagId');history('UPDATE','tag','tagId');eq('Tipe persisted',d.type,'ON_METAL');eq('Native persisted',d.tag_type,'On-Metal (Logam/Cairan)');eq('EPC tetap',d.epc,V('epc'));eq('Relasi tidak berubah',d.product_id,V('productIdLinked'));T('Snapshot tipe',()=>{const a=d.audit_history.find(x=>x.action==='UPDATE');pm.expect(a.before_data.tag_type).to.eql('Label Biasa (UHF)');pm.expect(a.after_data.tag_type).to.eql('On-Metal (Logam/Cairan)');});`);
add(3,'04.04 — Audit DEACTIVATE dan retensi EPC item','GET','/api/tags/{{tagIdDeactivate}}',200,undefined,`eq('EPC retained',d.epc,V('epcDeactivate'));id('Item masih ada',d.item_id);eq('Status',d.status,${ext}?'DAMAGED':'ENCODED');if(${ext}){history('DEACTIVATE','tag','tagIdDeactivate');T('Alasan dan snapshot DEACTIVATE',()=>{const a=d.audit_history.find(x=>x.action==='DEACTIVATE');pm.expect(a.reason).to.eql(${JSON.stringify(reason)});pm.expect(a.before_data.status).to.eql('ENCODED');pm.expect(a.after_data.status).to.eql('DAMAGED');});}else eq('Tidak ada audit DEACTIVATE palsu',d.audit_history.filter(x=>x.action==='DEACTIVATE').length,0);`);
add(3,'04.05 — DELETE produk berelasi ditolak','DELETE','/api/products/{{productIdLinked}}',409);
add(3,'04.06 — READ produk berelasi tetap ada','GET','/api/products/{{productIdLinked}}',200,undefined,`eq('ID utuh',d.id,V('productIdLinked'));eq('Stok tidak naik karena encoding',d.current_stock,0);`);
add(3,'04.07 — DELETE fixture stok dan ledger ditolak','DELETE','/api/products/{{fixtureProductId}}',409);
add(3,'04.08 — READ fixture stok tetap','GET','/api/products/{{fixtureProductId}}',200,undefined,`eq('Stok retained',d.current_stock,7);`);
add(3,'04.09 — DELETE produk hanya relasi ledger ditolak','DELETE','/api/products/{{fixtureLedgerProductId}}',409);
add(3,'04.10 — READ produk ledger tanpa stok tetap ada','GET','/api/products/{{fixtureLedgerProductId}}',200,undefined,`eq('UUID retained',d.id,V('fixtureLedgerProductId'));eq('Stok nol',d.current_stock,0);`);
add(4,'05.01 — HEALTH QA','GET','/api/health',200,undefined,`eq('Status',j.status,'OK');eq('Identitas QA',j.qa.kind,'digiwms-postman-disposable-pg');`,{health:true});
add(4,'05.02 — JSON malformed','POST','/api/products',400,'{"sku":', '',{native:true});
const qa={info:{name:'DigiWMS Orang 1 — QA CRUD API Testing',_postman_id:crypto.randomUUID(),schema,description:'HANYA server disposable tests/postman/run.ts. Port 5000 Production ditolak. Mulai dari request 01.00. Tidak ada migrasi atau koneksi MQTT.'},event:[ev('prerequest',guard)],item:folders};
const prodGuard=`if(pm.request.method!=='GET')throw new Error('Production collection must remain GET-only.');`;
const prod={info:{name:'DigiWMS Orang 1 — Production Read Only',_postman_id:crypto.randomUUID(),schema,description:'Hanya tujuh GET. Tidak ada skrip sendRequest, migrasi, mutasi status, atau MQTT. Label health bukan bukti database.'},event:[ev('prerequest',prodGuard)],item:[]};
for(const [entity,url,key] of [['products','/api/products','productionProductId'],['grn','/api/inbound/grn','productionGrnId'],['tags','/api/tags','productionTagId']]){
 const check=`pm.test('HTTP 200',()=>pm.response.to.have.status(200));const j=pm.response.json();pm.test('Envelope',()=>pm.expect(j.success).to.eql(true));const re=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;`;
 prod.item.push({name:'READ daftar '+entity,request:{method:'GET',url:'{{baseUrl}}'+url},event:[ev('prerequest',`pm.environment.unset('${key}');`),ev('test',check+`pm.test('Array dan UUID',()=>{pm.expect(j.data).to.be.an('array');j.data.forEach(x=>pm.expect(x.id).to.match(re));});if(j.data.length&&re.test(j.data[0].id))pm.environment.set('${key}',j.data[0].id);else pm.execution.setNextRequest(null);`)]});
 prod.item.push({name:'READ detail '+entity,request:{method:'GET',url:'{{baseUrl}}'+url+'/{{'+key+'}}'},event:[ev('prerequest',`if(!pm.environment.get('${key}')){pm.request.url.update('http://127.0.0.1:1/NO-ID');if(pm.execution.skipRequest)pm.execution.skipRequest();throw new Error('Run list request first; empty dataset cannot validate detail.');}`),ev('test',check+`pm.test('UUID utuh',()=>{pm.expect(j.data.id).to.match(re);pm.expect(j.data.id).to.eql(pm.environment.get('${key}'));});`+(entity==='tags'?`pm.test('EPC legacy boleh dibaca',()=>pm.expect(j.data.epc).to.be.a('string'));`:'')+(entity!=='products'?`pm.test('Riwayat berupa array, boleh kosong',()=>pm.expect(j.data.audit_history).to.be.an('array'));`:''))]});
}
prod.item.unshift({name:'HEALTH Production (bukan bukti database)',request:{method:'GET',url:'{{baseUrl}}/api/health'},event:[ev('test',`pm.test('HTTP 200',()=>pm.response.to.have.status(200));const j=pm.response.json();pm.test('Status OK',()=>pm.expect(j.status).to.eql('OK'));pm.test('JSON object',()=>pm.expect(j).to.be.an('object'));`)]});
const save=(name,data)=>fs.writeFileSync(path.join(root,name),JSON.stringify(data,null,2)+'\n');
save('DigiWMS_Orang1_QA_CRUD.postman_collection.json',qa);
save('DigiWMS_Orang1_Production_ReadOnly.postman_collection.json',prod);
const vars=['productId','productIdLinked','productIdOther','grnId','grnIdCancel','tagId','tagIdReassign','tagIdDeactivate','itemId','epc','epcReassign','epcDeactivate','epcUnused','qaRunId','qaSku','qaPoNumber','qaNonce','missingId','supportsExtendedStatus','fixtureProductId','fixtureTagId','fixtureGrnId','fixtureLedgerProductId','fixtureTransactionTagId','qaFailed'];
for(const [name,base,keys] of [['QA','http://127.0.0.1:5001',vars],['Production_ReadOnly','http://localhost:5000',['productionProductId','productionGrnId','productionTagId']]])save('DigiWMS_Orang1_'+name+'.postman_environment.json',{id:crypto.randomUUID(),name:'DigiWMS Orang 1 '+name,values:[{key:'baseUrl',value:base,enabled:true,type:'default'},...keys.map(key=>({key,value:'',enabled:true,type:'default'}))],_postman_variable_scope:'environment'});
save('scenarios.json',specs);
console.log('Generated '+specs.length+' QA requests and '+prod.item.length+' Production GET requests.');
