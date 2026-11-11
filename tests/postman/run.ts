/** Test-only HTTP server + real Newman runner. No server.ts, migration helper, or MQTT init. */
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import net from 'node:net';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { Pool } from 'pg';
import { orang1InboundRoutes } from '../../src/modules/orang1-inbound/routes';
import { PostgresRepository } from '../../src/modules/orang1-inbound/repository';

const root = path.resolve('tests/postman');
const evidence = path.join(root, 'evidence'); mkdirSync(evidence, { recursive: true });
const toolsRoot = process.env.ORANG1_POSTMAN_TOOLS || path.join(os.tmpdir(), 'digiwms-postman-tools');
const toolRequire = createRequire(path.join(toolsRoot, 'package.json'));
const newman = toolRequire('newman');
const sdk = toolRequire('postman-collection');
const Ajv = toolRequire('ajv-draft-04');
const json = (name: string) => JSON.parse(readFileSync(path.join(root, name), 'utf8'));
const write = (name: string, value: unknown) => writeFileSync(path.join(evidence, name), JSON.stringify(value, null, 2) + '\n');
const uid = () => randomUUID().replaceAll('-', '');
const collectionName = 'DigiWMS_Orang1_QA_CRUD.postman_collection.json';
const environmentName = 'DigiWMS_Orang1_QA.postman_environment.json';
const pgBin = process.env.ORANG1_POSTMAN_PG_BIN || 'C:/Program Files/PostgreSQL/16/bin';
const cluster = path.join(os.tmpdir(), 'digiwms-postman-pg-' + uid());
const connectionString = 'postgresql://postgres@127.0.0.1:55432/postgres'; // disposable, no credentials
let admin: Pool | undefined;
let started = false;
let closing = false;
const output: any[] = [];
const checks: { name: string; status: string }[] = [];

function exe(name: string, args: string[]) {
  const result = spawnSync(path.join(pgBin, name + '.exe'), args, { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  assert.equal(result.status, 0, name + ' failed: ' + (result.stderr || result.error?.message || 'see task-owned PG log'));
}
async function free(port: number) {
  await new Promise<void>((resolve, reject) => {
    const probe = net.createServer(); probe.once('error', reject);
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve()));
  });
}
function check(name: string, fn: () => void) { fn(); checks.push({ name, status: 'PASS' }); }

// Baseline excludes only our new artifacts and generated build/dependency trees.
function baseline() {
  const result: Record<string, string> = {};
  for (const repo of ['BACKEND-DIGI-WMS', 'FRONTEND-DIGI-WMS']) {
    const base = path.resolve('..', repo);
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (['.git','node_modules','dist'].includes(e.name)) continue;
        const p = path.join(dir, e.name);
        if (p === root) continue;
        if (e.isDirectory()) walk(p);
        else if (e.isFile()) result[path.relative(path.resolve('..'), p)] = createHash('sha256').update(readFileSync(p)).digest('hex');
      }
    };
    walk(base);
  }
  return result;
}
const before = baseline();

async function run(label: string, collection: any, environment: any, expectedFailure = false) {
  const began = new Date();
  const summary: any = await new Promise((resolve, reject) => {
    newman.run({ collection, environment, reporters: [], bail: true, timeoutRequest: 8000, timeoutScript: 10000, iterationCount: 1 }, (err: any, data: any) => err ? reject(err) : resolve(data));
  });
  // Newman also records pm.sendRequest health checks, sharing the item's execution object.
  // Deduplicate by SDK item ID; raw stats.requests still counts all real HTTP calls.
  const executions = [...new Map(summary.run.executions.map((e: any) => [e.item.id, e])).values()] as any[];
  const rows = executions.map((e: any) => ({
    name: e.item.name, method: e.request.method,
    // Only path template, never raw Production responses / environment / credentials.
    statusCode: e.response?.code ?? null, durationMs: e.response?.responseTime ?? null,
    assertions: (e.assertions || []).map((a: any) => ({ name: a.assertion, status: a.skipped ? 'SKIP' : a.error ? 'FAIL' : 'PASS', ...(a.error ? { error: a.error.message } : {}) })),
  }));
  const failures = summary.run.failures.map((f: any) => ({ at: f.at, name: f.error?.name, message: f.error?.message }));
  const record = { label, startedAt: began.toISOString(), finishedAt: new Date().toISOString(),
    elapsedMs: Date.now() - began.getTime(), stats: summary.run.stats, collectionItems: rows.length,
    guardPreflightRequests: Math.max(0,summary.run.stats.requests.total-rows.filter((r:any)=>r.statusCode!==null).length),
    requests: rows, failures, expectedFailure };
  write(label + '.json', record); output.push(record);
  if (!expectedFailure) assert.equal(failures.length, 0, label + ': ' + JSON.stringify(failures));
  return { summary, record };
}

function validate() {
  const schemaFile = path.join(root, 'collection-schema-v2.1.json');
  assert.ok(existsSync(schemaFile), 'Download official public schema first (see README).');
  const validate = new Ajv({ strict: false, allErrors: true }).compile(JSON.parse(readFileSync(schemaFile, 'utf8')));
  for (const f of [collectionName, 'DigiWMS_Orang1_Production_ReadOnly.postman_collection.json']) {
    const c = json(f); assert.ok(validate(c), JSON.stringify(validate.errors));
    const imported = new sdk.Collection(c); assert.ok(imported.items.count() > 0);
    checks.push({ name: 'Official v2.1 schema + Postman SDK import: ' + f, status: 'PASS' });
  }
  const prod = json('DigiWMS_Orang1_Production_ReadOnly.postman_collection.json');
  check('Production exactly seven GET; no sendRequest/runRequest or mutation scripts', () => {
    assert.equal(prod.item.length, 7); prod.item.forEach((i: any) => assert.equal(i.request.method, 'GET'));
    assert.doesNotMatch(JSON.stringify({event:prod.event,item:prod.item}), /sendRequest|runRequest|\/verify|\/cancel|\/deactivate|mqtt:\/\//);
  });
  for (const f of [environmentName, 'DigiWMS_Orang1_Production_ReadOnly.postman_environment.json']) {
    const env = json(f); check('Environment empty identities / no credentials: ' + f, () => {
      assert.equal(env._postman_variable_scope, 'environment');
      env.values.forEach((v: any) => { if (v.key !== 'baseUrl') assert.equal(v.value, ''); });
      assert.doesNotMatch(JSON.stringify(env), /password|service_role|postgresql:|supabase\.co|token/i);
    });
  }
}

async function safetyTests() {
  const qa = json(collectionName);
  const env = json(environmentName);
  env.values.find((v: any) => v.key === 'baseUrl').value = 'http://localhost:5000';
  const a = await run('guard-production-url', qa, env, true);
  check('Collection rejects port 5000 before any API request', () => { assert.ok(a.record.failures.length); assert.equal(a.record.requests.filter((r: any) => r.statusCode !== null).length, 0); });
  // A responding localhost server is insufficient: require disposable proof.
  const fake = Fastify(); let writes = 0;
  fake.addHook('onRequest', async r => { if (r.method !== 'GET') writes++; });
  fake.get('/api/health', async () => ({ status: 'OK', database_mode: 'POSTGRESQL_DOCKER' }));
  await fake.listen({ port: 5001, host: '127.0.0.1' });
  try {
    const b = await run('guard-unproven-database', qa, json(environmentName), true);
    check('Unproven database is rejected; zero writes reached target', () => { assert.ok(b.record.failures.length); assert.equal(writes, 0); });
  } finally { await fake.close(); }
}

async function fixture(extended: boolean) {
  assert.ok(admin);
  // Schema name is generated here, never supplied by environment or a Postman client.
  const schema = 'orang1_postman_' + uid();
  await admin!.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 5 });
  const nonce = uid(); const events: any[] = [];
  let ddl = readFileSync('tests/fixtures/supabase-orang1.sql', 'utf8');
  // Fixture definition only. No ALTER of existing constraints and no migration file is read/executed.
  if (extended) ddl = ddl.replace("('MENUNGGU_VERIFIKASI','SELESAI')", "('MENUNGGU_VERIFIKASI','SELESAI','DIBATALKAN')")
    .replace("('UNASSIGNED','ENCODED','IN_STOCK','RESERVED','AUTHORIZED_OUT','EXITED')", "('UNASSIGNED','ENCODED','IN_STOCK','RESERVED','AUTHORIZED_OUT','EXITED','DAMAGED')");
  await pool.query(ddl);
  await pool.query(`CREATE TABLE orang1_inbound_audit (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    entity_type TEXT NOT NULL CHECK(entity_type IN ('product','grn','tag')),
    entity_id TEXT NOT NULL, action TEXT NOT NULL, before_data JSONB,
    after_data JSONB NOT NULL, reason TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE INDEX orang1_postman_audit_entity_idx ON orang1_inbound_audit(entity_type,entity_id,id);
    ALTER TABLE orang1_inbound_audit ENABLE ROW LEVEL SECURITY;`);
  const p = (await pool.query("INSERT INTO products(sku,name,category,current_stock) VALUES($1,'Fixture QA relasi','QA',7) RETURNING *", ['QA-O1-SKU-FIXTURE-' + uid()])).rows[0];
  const g = (await pool.query("INSERT INTO goods_receipts(po_number,supplier_name,total_qty) VALUES($1,'Fixture QA',1) RETURNING *", ['QA-O1-PO-FIXTURE-' + uid()])).rows[0];
  const t = (await pool.query("INSERT INTO tags(epc,status) VALUES('QA-LEGACY-EPC','IN_STOCK') RETURNING *")).rows[0];
  await pool.query("INSERT INTO items(tag_id,product_id,grn_id,status) VALUES($1,$2,$3,'IN_STOCK')", [t.id,p.id,g.id]);
  await pool.query("INSERT INTO stock_movements(tx_code,movement_type,product_id,sku,tag_id,from_location,to_location,qty_change,qty_label,reference_doc) VALUES($1,'INBOUND',$2,$3,$4,'QA','QA',7,'+7',$5)", ['QA-'+uid(),p.id,p.sku,t.id,g.po_number]);
  const ledgerProduct=(await pool.query("INSERT INTO products(sku,name,category) VALUES($1,'Fixture QA ledger saja','QA') RETURNING *",['QA-O1-SKU-LEDGER-'+uid()])).rows[0];
  const transactionTag=(await pool.query("INSERT INTO tags(epc,status) VALUES($1,'ENCODED') RETURNING *",[uid().slice(0,24).toUpperCase()])).rows[0];
  await pool.query("INSERT INTO items(tag_id,product_id,status) VALUES($1,$2,'ENCODED')",[transactionTag.id,p.id]);
  await pool.query("INSERT INTO stock_movements(tx_code,movement_type,product_id,sku,from_location,to_location,qty_change,qty_label) VALUES($1,'INBOUND',$2,$3,'QA','QA',0,'0')",['QA-'+uid(),ledgerProduct.id,ledgerProduct.sku]);
  await pool.query("INSERT INTO stock_movements(tx_code,movement_type,product_id,sku,tag_id,from_location,to_location,qty_change,qty_label) VALUES($1,'INBOUND',$2,$3,$4,'QA','QA',0,'0')",['QA-'+uid(),p.id,p.sku,transactionTag.id]);
  const fixtures = { fixtureProductId: p.id, fixtureGrnId: g.id, fixtureTagId: t.id, fixtureLedgerProductId:ledgerProduct.id, fixtureTransactionTagId:transactionTag.id };
  const ledgerBefore = (await pool.query('SELECT * FROM stock_movements ORDER BY id')).rows;
  const protectedBefore = JSON.stringify({ p, g, t, ledgerProduct,transactionTag });
  const app = Fastify();
  await app.register(cors, { origin: true });
  app.addHook('onRequest', async (req, reply) => {
    if (['GET','HEAD','OPTIONS'].includes(req.method)) return;
    if (req.headers['x-orang1-qa-nonce'] !== nonce || !/^[a-f0-9]{32}$/.test(String(req.headers['x-orang1-qa-run'] || '')))
      return reply.code(403).send({ success: false, message: 'Disposable QA attestation headers required.' });
  });
  app.get('/api/health', async () => ({ status: 'OK', database_mode: 'DISPOSABLE_POSTGRESQL_QA', qa: {
    kind: 'digiwms-postman-disposable-pg', isolated: true, schema, nonce, extended, mqtt: 'spy', fixtures,
  } }));
  await app.register(orang1InboundRoutes, { repository: new PostgresRepository(pool, undefined, schema), publish: (topic: string, payload: any) => events.push({ topic, payload }) });
  const close = async () => { await app.close(); await pool.end(); assert.match(schema, /^orang1_postman_[a-f0-9]{32}$/); await admin!.query(`DROP SCHEMA ${schema} CASCADE`); };
  return { pool, app, close, schema, events, fixtures, ledgerBefore, protectedBefore };
}

async function integration(f: Awaited<ReturnType<typeof fixture>>, env: any, extended: boolean) {
  const v = (key: string) => env.get(key);
  const row = async (table: string, id: string) => (await f.pool.query(`SELECT * FROM ${table} WHERE id::text=$1`, [id])).rows[0];
  const ledger = (await f.pool.query('SELECT * FROM stock_movements ORDER BY id')).rows;
  check('DB '+extended+': ledger unchanged; encoding made no movement', () => assert.deepEqual(ledger, f.ledgerBefore));
  const currentFixture = { p: await row('products',f.fixtures.fixtureProductId),g:await row('goods_receipts',f.fixtures.fixtureGrnId),t:await row('tags',f.fixtures.fixtureTagId),ledgerProduct:await row('products',f.fixtures.fixtureLedgerProductId),transactionTag:await row('tags',f.fixtures.fixtureTransactionTagId) };
  check('DB '+extended+': fixture product/GRN/tag untouched', () => assert.equal(JSON.stringify(currentFixture), f.protectedBefore));
  const orphan = (await f.pool.query('SELECT count(*)::int AS n FROM items i LEFT JOIN products p ON p.id=i.product_id LEFT JOIN tags t ON t.id=i.tag_id LEFT JOIN goods_receipts g ON g.id=i.grn_id WHERE p.id IS NULL OR t.id IS NULL OR (i.grn_id IS NOT NULL AND g.id IS NULL)')).rows[0].n;
  check('DB '+extended+': no item/product/tag orphan', () => assert.equal(orphan, 0));
  const mismatch=(await f.pool.query('SELECT count(*)::int AS n FROM stock_movements m JOIN items i ON i.tag_id=m.tag_id WHERE m.product_id IS DISTINCT FROM i.product_id')).rows[0].n;
  check('DB '+extended+': ledger tag/product relationship consistent',()=>assert.equal(mismatch,0));
  const item = await row('items',v('itemId'));
  check('DB '+extended+': native UUID item/product/tag/GRN relationship', () => { assert.equal(item.product_id,v('productIdLinked'));assert.equal(item.tag_id,v('tagId'));assert.equal(item.grn_id,v('grnId'));assert.equal(item.status,'ENCODED');assert.equal(item.location_id,null); });
  const reassign = (await f.pool.query('SELECT product_id FROM items WHERE tag_id=$1',[v('tagIdReassign')])).rows[0];
  check('DB '+extended+': reassignment persisted in items',()=>assert.equal(reassign.product_id,v('productIdOther')));
  const deleted = await row('products',v('productId'));
  const audit = (await f.pool.query('SELECT * FROM orang1_inbound_audit ORDER BY id')).rows;
  check('DB '+extended+': deleted QA product retained in audit',()=>{assert.equal(deleted,undefined);const a=audit.filter(x=>x.entity_id===v('productId'));assert.deepEqual(a.map(x=>x.action),['CREATE','UPDATE','DELETE']);assert.equal(a[0].before_data,null);assert.equal(a[1].before_data.name,'Produk Sintetis QA');assert.equal(a[1].after_data.name,'Produk QA Diperbarui');assert.equal(a[2].before_data.id,v('productId'));assert.deepEqual(a[2].after_data,{});});
  check('DB '+extended+': failed operations leave no extra audit',()=>assert.equal(audit.length,extended?16:14));
  check('DB '+extended+': all audit entity IDs retain UUID strings',()=>audit.forEach(a=>assert.match(a.entity_id,/^[a-f0-9-]{36}$/)));
  const damaged = await row('tags',v('tagIdDeactivate'));
  const retainedItem = (await f.pool.query('SELECT * FROM items WHERE tag_id=$1',[damaged.id])).rows[0];
  check('DB '+extended+': damaged/encoded EPC and item retained',()=>{assert.equal(damaged.epc,v('epcDeactivate'));assert.equal(damaged.status,extended?'DAMAGED':'ENCODED');assert.ok(retainedItem);assert.equal(retainedItem.status,'ENCODED');});
  check('DB '+extended+': exactly three simulated publisher spy calls',()=>{assert.equal(f.events.length,3);f.events.forEach(e=>{assert.equal(e.topic,'wms/tags/encoded');assert.equal(e.payload.hardware_confirmed,false);assert.equal(e.payload.mode,'simulation');});});
  const denied = await f.app.inject({ method: 'POST', url: '/api/products', payload: {sku:'SHOULD-NOT-WRITE'} });
  check('DB '+extended+': server refuses un-attested mutation',()=>assert.equal(denied.statusCode,403));
}

async function stop() {
  if (closing) return; closing = true;
  await admin?.end(); admin = undefined;
  if (started) { assert.match(cluster.replaceAll('\\','/'), /\/digiwms-postman-pg-[a-f0-9]{32}$/); exe('pg_ctl',['-D',cluster,'-m','fast','-w','stop']); started=false; }
}

async function setupFailureTest() {
  const f=await fixture(true);
  await f.app.listen({port:5001,host:'127.0.0.1'});
  try {
    const c=json(collectionName);
    // Intentional fixture fault: product setup rejected. Remaining dependent requests must stop.
    const request=c.item[0].item[1]; const b=JSON.parse(request.request.body.raw);b.name='';request.request.body.raw=JSON.stringify(b);
    const {record}=await run('guard-setup-failure',c,json(environmentName),true);
    const count=(await f.pool.query('SELECT count(*)::int AS n FROM products')).rows[0].n;
    check('Failed product setup stops collection before subsequent CRUD',()=>{assert.ok(record.failures.length);assert.equal(count,2);assert.equal(record.requests.filter((r:any)=>r.method!=='GET').length,1);assert.ok(record.requests.every((r:any)=>!['DELETE','PUT','PATCH'].includes(r.method)));});
  } finally {await f.close();}
}
async function main() {
  const serve = process.argv.includes('--serve');
  validate(); await free(5001); if(!serve) await safetyTests();
  await free(55432);
  exe('initdb',['-D',cluster,'-U','postgres','-A','trust','--no-locale','--encoding=UTF8']);
  exe('pg_ctl',['-D',cluster,'-l',path.join(cluster,'qa-server.log'),'-o','-h 127.0.0.1 -p 55432','-w','start']); started=true;
  admin = new Pool({connectionString});
  const actual = (await admin.query('SHOW data_directory')).rows[0].data_directory;
  assert.equal(path.resolve(actual), path.resolve(cluster));
  check('Server database identity: exact task-owned disposable data_directory',()=>assert.equal(path.resolve(actual),path.resolve(cluster)));
  try {
    if(!serve)await setupFailureTest();
    const modes = serve ? [!process.argv.includes('--strict')] : [true, false];
    for (const extended of modes) {
      const f = await fixture(extended);
      await f.app.listen({port:5001,host:'127.0.0.1'});
      if (serve) {
        console.log('Disposable Postman QA ready: http://127.0.0.1:5001 ; mode='+ (extended?'capability':'strict') +'; MQTT=spy; Ctrl+C cleans up task-owned schema/cluster.');
        await new Promise<void>(resolve=>{process.once('SIGINT',()=>resolve());process.once('SIGTERM',()=>resolve());});
        await f.close(); break;
      }
      try {
        const {summary,record} = await run(extended?'qa-capability':'qa-strict',json(collectionName),json(environmentName));
        assert.equal(record.requests.filter((r:any)=>r.statusCode!==null).length, json('scenarios.json').length, 'No silent skipping');
        await integration(f,summary.environment,extended);
      } finally { await f.close(); }
    }
    if (!serve && !process.argv.includes('--qa-only')) await run('production-readonly',json('DigiWMS_Orang1_Production_ReadOnly.postman_collection.json'),json('DigiWMS_Orang1_Production_ReadOnly.postman_environment.json'));
  } finally { await stop(); }
  check('Existing source/config/env/migrations unchanged by runner',()=>assert.deepEqual(baseline(),before));
  if(serve) return;
  write('integration-checks.json',{at:new Date().toISOString(),checks});
  write('summary.json',{at:new Date().toISOString(),newmanVersion:toolRequire('newman/package.json').version,checks:checks.length,runs:output.map(x=>({label:x.label,expectedFailure:x.expectedFailure,elapsedMs:x.elapsedMs,stats:x.stats,failures:x.failures.length}))});
  console.log(JSON.stringify(output.map(x=>({label:x.label,requests:x.requests.length,assertions:x.stats.assertions,failures:x.failures.length,expectedFailure:x.expectedFailure})),null,2));
  console.log('Separate integration/safety checks PASS: '+checks.length);
  if(existsSync(path.join(evidence,'last-error.json')))unlinkSync(path.join(evidence,'last-error.json'));
}
main().catch(async e=>{console.error(e.message);write('last-error.json',{message:e.message,at:new Date().toISOString()});await stop();process.exitCode=1;});
