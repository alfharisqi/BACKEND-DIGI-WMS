import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { Pool } from 'pg';
import { orang1InboundRoutes } from '../src/modules/orang1-inbound/routes';
import { MemoryRepository, PostgresRepository, Repository } from '../src/modules/orang1-inbound/repository';
import { Row } from '../src/modules/orang1-inbound/validation';

const uuid1 = '18b635db-0ec3-41b1-a1ec-e15da1438ce2';
const uuid2 = '28b635db-0ec3-41b1-a1ec-e15da1438ce2';
const productBody = (sku = 'TEST-NEW') => ({ sku, name: 'Produk Pengujian', category: 'QA', price: 1234.56, min_stock_alert: 0 });
const grnBody = (po = 'TEST-PO') => ({ po_number: po, supplier_name: 'Supplier QA', receipt_date: '2026-11-05', total_qty: 2 });
type Harness = Awaited<ReturnType<typeof harness>>;
async function harness(kind: 'memory' | 'postgres', uuid: boolean) {
  const productId = uuid ? uuid1 : 1, secondId = uuid ? uuid2 : 2;
  const source: Record<string, Row[]> = {
    products: [{ ...productBody('TEST-ONE'), id: productId }, { ...productBody('TEST-TWO'), id: secondId }],
    tags: [], goods_receipts: [], items: [], stock_movements: [], gate_events: [],
  };
  let pool: Pool | undefined, admin: Pool | undefined, schema = '';
  let repository: Repository;
  if (kind === 'postgres') {
    const url = new URL(process.env.ORANG1_TEST_DATABASE_URL!);
    assert.ok(['localhost', '127.0.0.1'].includes(url.hostname), 'Tests only support an explicitly configured local test database');
    assert.equal(process.env.ORANG1_TEST_ISOLATED, '1', 'Explicit isolation acknowledgement required');
    schema = `orang1_test_${randomUUID().replaceAll('-', '')}`;
    admin = new Pool({ connectionString: url.href });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: url.href, options: `-c search_path=${schema}`, max: 5 });
    const original = await readFile('sql/init_schema.sql', 'utf8');
    let ddl = original.slice(original.indexOf('CREATE TABLE products'), original.indexOf('-- VIEW OTOMATIS'));
    if (uuid) ddl = ddl.replace(/(CREATE TABLE products\s*\(\s*id) SERIAL PRIMARY KEY/, '$1 UUID PRIMARY KEY DEFAULT gen_random_uuid()').replaceAll('product_id INT NOT NULL', 'product_id UUID NOT NULL');
    const gates = original.slice(original.indexOf('CREATE TABLE gate_events'), original.indexOf('CREATE TABLE alarms'));
    await pool.query('CREATE TABLE users (id SERIAL PRIMARY KEY)');
    await pool.query(ddl + gates);
    // Only the trusted migration's schema identifiers are relocated into this disposable QA schema.
    const auditMigration = (await readFile('sql/migrations/001_orang1_inbound_audit.sql', 'utf8')).replaceAll('public.', `${schema}.`).replaceAll("'public'", `'${schema}'`);
    await pool.query(auditMigration);
    for (const row of source.products) await pool.query('INSERT INTO products (id, sku, name, category, price, min_stock_alert) VALUES ($1,$2,$3,$4,$5,$6)', [row.id, row.sku, row.name, row.category, row.price, row.min_stock_alert]);
    if (!uuid) await pool.query("SELECT setval(pg_get_serial_sequence('products','id'), 2)");
    repository = new PostgresRepository(pool, undefined, schema);
  } else repository = new MemoryRepository(source);
  const events: Row[] = [];
  const app = Fastify();
  await app.register(orang1InboundRoutes, { repository, publish: (topic, payload) => { events.push({ topic, payload }); } });
  await app.ready();
  const request = async (method: string, path: string, payload?: Row, expected = 200) => {
    const response = await app.inject({ method: method as any, url: `/api${path}`, payload });
    const json = response.json();
    assert.equal(response.statusCode, expected, `${method} ${path}: ${JSON.stringify(json)}`);
    assert.equal(json.success, expected < 400, `success envelope: ${JSON.stringify(json)}`);
    return json;
  };
  const insert = (table: any, row: Row) => repository.transaction(repo => repo.insert(table, row));
  return { source, repository, request, insert, events, pool, productId, secondId,
    async close() {
      await app.close();
      if (pool && admin) {
        await pool.end();
        assert.match(schema, /^orang1_test_[a-f0-9]{32}$/);
        await admin.query(`DROP SCHEMA ${schema} CASCADE`);
        await admin.end();
      }
    },
  };
}

for (const kind of ['memory', 'postgres'] as const) for (const uuid of [false, true]) {
  describe(`${kind} / product IDs ${uuid ? 'UUID' : 'integer'}`, { skip: kind === 'postgres' && !process.env.ORANG1_TEST_DATABASE_URL }, () => {
    let h: Harness;
    before(async () => { h = await harness(kind, uuid); });
    after(async () => { await h?.close(); });
    const encode = (epc = '300833B2DDD9014000000001', extra: Row = {}) => h.request('POST', '/tags/encode', { product_id: h.productId, epc_custom: epc, ...extra }, 201);

    test('Product create, list, detail, update retains ID, delete without relations', async () => {
      const row = (await h.request('POST', '/products', productBody(), 201)).data;
      if (uuid) assert.match(row.id, /^[0-9a-f-]{36}$/);
      assert.ok((await h.request('GET', '/products')).data.some((p: Row) => p.id === row.id));
      assert.equal((await h.request('GET', `/products/${row.id}`)).data.sku, 'TEST-NEW');
      const updated = (await h.request('PUT', `/products/${row.id}`, { ...productBody('TEST-RENAMED'), price: 888, min_stock_alert: 7 })).data;
      assert.equal(updated.id, row.id); assert.equal(Number(updated.price), 888);
      await h.request('DELETE', `/products/${row.id}`);
      await h.request('GET', `/products/${row.id}`, undefined, 404);
    });
    test('Product duplicate SKU rejected', async () => { await h.request('POST', '/products', productBody('TEST-ONE'), 409); });
    test('Product negative price, minimum and missing required fields rejected', async () => {
      for (const invalid of [{ price: -1 }, { price: null }, { min_stock_alert: null }, { min_stock_alert: -1 }, { min_stock_alert: 1.5 }, { price: '5' }, { price: 1.001 }, { sku: ' ' }, { name: '' }, { category: '' }]) await h.request('POST', '/products', { ...productBody('TEST-INVALID'), ...invalid }, 400);
    });
    test('Unknown IDs and invalid identity formats rejected without coercion', async () => {
      const absent = randomUUID();
      await h.request('GET', `/products/${absent}`, undefined, 404);
      await h.request('PUT', `/products/${absent}`, productBody(), 404);
      await h.request('DELETE', `/products/${absent}`, undefined, 404);
      await h.request('GET', '/products/NaN', undefined, 400);
    });
    test('Legacy quick-add price and minimum aliases are persisted', async () => {
      const row = (await h.request('POST', '/products', { sku: 'TEST-QUICK', name: 'Quick', category: 'QA', price_idr: 900, min_stock: 3 }, 201)).data;
      assert.equal(Number(row.price), 900); assert.equal(row.min_stock_alert, 3);
    });
    test('Unsupported default location is explicitly rejected', async () => { await h.request('POST', '/products', { ...productBody('TEST-LOC'), default_location_code: 'Rak A1-01' }, 400); });
    test('GRN create, list, detail, edit and verify; RFID never auto-completed', async () => {
      const row = (await h.request('POST', '/inbound/grn', grnBody(), 201)).data;
      assert.equal(row.status, 'MENUNGGU_VERIFIKASI'); assert.equal(row.rfid_tagging_status, 'MENUNGGU_TAGGING');
      assert.ok((await h.request('GET', '/inbound/grn')).data.some((g: Row) => g.id === row.id));
      await h.request('GET', `/inbound/grn/${row.id}`);
      await h.request('PUT', `/inbound/grn/${row.id}`, { ...grnBody(), supplier_name: 'Supplier Koreksi' });
      const verified = (await h.request('PATCH', `/inbound/grn/${row.id}/verify`)).data;
      assert.equal(verified.status, 'SELESAI'); assert.equal(verified.rfid_tagging_status, 'MENUNGGU_TAGGING');
      await h.request('PATCH', `/inbound/grn/${row.id}/verify`, undefined, 409);
      await h.request('PUT', `/inbound/grn/${row.id}`, grnBody(), 409);
      await h.request('PATCH', `/inbound/grn/${row.id}/cancel`, { reason: 'Sudah terverifikasi' }, 409);
      const history = (await h.request('GET', `/inbound/grn/${row.id}`)).data.audit_history;
      assert.ok(history.some((a: Row) => a.action === 'VERIFY'));
    });
    test('GRN cancellation retains history, reason and prevents repeated cancellation', async () => {
      const row = (await h.request('POST', '/inbound/grn', grnBody('TEST-CANCEL'), 201)).data;
      await h.request('PATCH', `/inbound/grn/${row.id}/cancel`, { reason: '' }, 400);
      await h.request('PATCH', `/inbound/grn/${row.id}/cancel`, { reason: 'Supplier salah kirim' });
      const detail = (await h.request('GET', `/inbound/grn/${row.id}`)).data;
      assert.equal(detail.status, 'DIBATALKAN');
      assert.equal(detail.audit_history.at(-1).reason, 'Supplier salah kirim');
      await h.request('PATCH', `/inbound/grn/${row.id}/cancel`, { reason: 'Ulang' }, 409);
      await h.request('PATCH', `/inbound/grn/${row.id}/verify`, undefined, 409);
    });
    test('GRN duplicate PO, invalid quantities/dates and fabricated completion rejected', async () => {
      await h.request('POST', '/inbound/grn', grnBody(), 409);
      for (const invalid of [{ total_qty: 0 }, { total_qty: -1 }, { total_qty: 1.5 }, { total_qty: '2' }, { receipt_date: null }, { receipt_date: '0000-01-01' }, { receipt_date: '2026-02-30' }, { receipt_date: 'bad' }, { supplier_name: '' }, { po_number: '' }]) await h.request('POST', '/inbound/grn', { ...grnBody('TEST-BAD'), ...invalid }, 400);
      await h.request('POST', '/inbound/grn', { ...grnBody('TEST-AUTO'), status: 'SELESAI' }, 409);
      await h.request('POST', '/inbound/grn', { ...grnBody('TEST-AUTO'), rfid_tagging_status: 'Auto-Encoded' }, 409);
      await h.request('POST', '/inbound/grn', { ...grnBody('TEST-PROD'), product_id: h.productId }, 400);
    });
    test('RFID valid EPC normalized; product ID retained in item, response and MQTT', async () => {
      const result = await encode('300833b2ddd9014000000001');
      assert.equal(result.data.tag.epc, '300833B2DDD9014000000001');
      assert.equal(result.data.item.product_id, h.productId);
      assert.equal(result.data.tag.product_id, h.productId);
      assert.equal(result.tag.id, result.data.tag.id);
      assert.equal(result.data.hardware_confirmed, false);
      assert.equal(h.events.at(-1)!.payload.product_id, h.productId);
      assert.equal(h.events.at(-1)!.topic, 'wms/tags/encoded');
      assert.equal((await h.request('GET', `/tags/${result.tag.id}`)).data.sku, 'TEST-ONE');
      assert.ok((await h.request('GET', '/tags')).data.some((t: Row) => t.epc === result.tag.epc));
    });
    test('RFID duplicate, malformed EPC, wrong type, unknown product and hardware mode rejected with no MQTT', async () => {
      const before = h.events.length, count = (await h.repository.all('tags')).length;
      await h.request('POST', '/tags/encode', { product_id: h.productId, epc_custom: '300833B2DDD9014000000001' }, 409);
      for (const epc of ['E280-1160-2000-012A', '300833B2', 'Z'.repeat(24), '1'.repeat(25)]) await h.request('POST', '/tags/encode', { product_id: h.productId, epc_custom: epc }, 400);
      await h.request('POST', '/tags/encode', { product_id: randomUUID(), epc_custom: '300833B2DDD9014000000002' }, 404);
      await h.request('POST', '/tags/encode', { product_id: h.productId, type: 'BAD' }, 400);
      await h.request('POST', '/tags/encode', { product_id: h.productId, type: null }, 400);
      await h.request('POST', '/tags/encode', { product_id: h.productId, epc_custom: null }, 400);
      await h.request('POST', '/tags/encode', { product_id: h.productId, mode: 'hardware' }, 409);
      await h.request('POST', '/tags/encode', { product_id: h.productId, status: 'IN_STOCK' }, 409);
      assert.equal(h.events.length, before); assert.equal((await h.repository.all('tags')).length, count);
    });
    test('Simulation generator produces 24 hexadecimal digits', async () => {
      const result = await h.request('POST', '/tags/encode', { product_id: h.productId }, 201);
      assert.match(result.tag.epc, /^[0-9A-F]{24}$/);
    });
    test('Tag edit preserves EPC; reassignment before stock recorded with old and new identities', async () => {
      const { tag } = await encode('300833B2DDD9014000000003');
      await h.request('PATCH', `/tags/${tag.id}`, { type: 'ON_METAL', product_id: h.secondId });
      const detail = (await h.request('GET', `/tags/${tag.id}`)).data;
      assert.equal(detail.product_id, h.secondId); assert.equal(detail.epc, tag.epc); assert.equal(detail.type, 'ON_METAL');
      assert.equal(detail.audit_history.at(-1).before_data.product_id, h.productId);
      assert.equal(detail.audit_history.at(-1).after_data.product_id, h.secondId);
      await h.request('PATCH', `/tags/${tag.id}`, { epc: '300833B2DDD9014000000004' }, 409);
    });
    test('Tag deactivation uses DAMAGED and retains item/EPC/reason; EPC reuse rejected', async () => {
      const { tag, item } = await encode('300833B2DDD9014000000005');
      await h.request('PATCH', `/tags/${tag.id}/deactivate`, { reason: 'Rusak saat penerimaan' });
      const detail = (await h.request('GET', `/tags/${tag.id}`)).data;
      assert.equal(detail.status, 'DAMAGED'); assert.equal(detail.audit_history.at(-1).reason, 'Rusak saat penerimaan');
      assert.ok((await h.repository.all('items')).some(i => i.id === item.id));
      await h.request('POST', '/tags/encode', { product_id: h.productId, epc_custom: tag.epc }, 409);
      await h.request('PATCH', `/tags/${tag.id}/deactivate`, { reason: 'Ulang' }, 409);
    });
    test('Tag invalid status transitions and missing deactivate reason rejected', async () => {
      const { tag } = await encode('300833B2DDD9014000000006');
      for (const status of ['IN_STOCK', 'RESERVED', 'DAMAGED', 'ENCODED']) await h.request('PATCH', `/tags/${tag.id}`, { status }, 409);
      await h.request('PATCH', `/tags/${tag.id}/deactivate`, { reason: ' ' }, 400);
    });
    test('UNASSIGNED to ENCODED requires product and publishes after persistence', async () => {
      const tag = await h.insert('tags', { epc: '300833B2DDD9014000000007', type: 'HARD_TAG', status: 'UNASSIGNED' });
      await h.request('PATCH', `/tags/${tag.id}`, { status: 'ENCODED' }, 400);
      const before = h.events.length;
      await h.request('PATCH', `/tags/${tag.id}`, { status: 'ENCODED', product_id: h.productId });
      assert.equal(h.events.length, before + 1);
      assert.ok((await h.repository.all('items')).some(i => i.tag_id === tag.id && i.product_id === h.productId));
    });
    test('Product deletion with item/tag/ledger relations is rejected', async () => {
      await h.request('DELETE', `/products/${h.productId}`, undefined, 409);
      const ledgerProduct = (await h.request('POST', '/products', productBody('TEST-LEDGER'), 201)).data;
      await h.insert('stock_movements', { tx_code: 'TX-QA-DELETE', movement_type: 'INBOUND_GRN', product_id: ledgerProduct.id, from_location: 'QA', to_location: 'QA', qty: 1, reference_doc: 'QA' });
      await h.request('DELETE', `/products/${ledgerProduct.id}`, undefined, 409);
      assert.equal((await h.request('GET', `/products/${ledgerProduct.id}`)).data.current_stock, 1);
    });
    test('GRN with stock effect cannot be cancelled or edited; ledger remains unchanged', async () => {
      const grn = (await h.request('POST', '/inbound/grn', grnBody('TEST-STOCK-GRN'), 201)).data;
      await h.insert('stock_movements', { tx_code: 'TX-QA-GRN', movement_type: 'PUTAWAY', product_id: h.productId, from_location: 'QA', to_location: 'QA Rack', qty: 1, reference_doc: grn.po_number });
      const before = JSON.stringify(await h.repository.all('stock_movements'));
      await h.request('PATCH', `/inbound/grn/${grn.id}/cancel`, { reason: 'Tidak boleh' }, 409);
      await h.request('PUT', `/inbound/grn/${grn.id}`, grnBody('TEST-CHANGED'), 409);
      assert.equal(JSON.stringify(await h.repository.all('stock_movements')), before);
    });
    test('GRN link, capacity limit and cancellation protection', async () => {
      const grn = (await h.request('POST', '/inbound/grn', { ...grnBody('TEST-LINK'), total_qty: 1 }, 201)).data;
      const { tag } = await encode('300833B2DDD9014000000008', { grn_id: grn.id });
      assert.equal((await h.request('GET', `/tags/${tag.id}`)).data.grn_id, grn.id);
      await h.request('POST', '/tags/encode', { product_id: h.productId, grn_id: grn.id }, 409);
      await h.request('PATCH', `/inbound/grn/${grn.id}/cancel`, { reason: 'Terhubung item' }, 409);
      await h.request('PATCH', `/tags/${tag.id}`, { product_id: h.secondId }, 409);
    });
    test('Tag history in ledger/gate or final status prevents deactivation and reassignment', async () => {
      const { tag, item } = await encode('300833B2DDD9014000000009');
      await h.insert('stock_movements', { tx_code: 'TX-QA-TAG', movement_type: 'PUTAWAY', product_id: h.productId, item_id: item.id, from_location: 'QA', to_location: 'Rack', qty: 1 });
      await h.request('PATCH', `/tags/${tag.id}/deactivate`, { reason: 'Tidak boleh' }, 409);
      await h.request('PATCH', `/tags/${tag.id}`, { product_id: h.secondId }, 409);
      const gateTag = (await encode('300833B2DDD901400000000A')).tag;
      await h.insert('gate_events', { gate_id: 'QA', epc: gateTag.epc, antenna_info: 'QA', rssi_dbm: -50, is_authorized: false, action_taken: 'QA' });
      await h.request('PATCH', `/tags/${gateTag.id}/deactivate`, { reason: 'Tidak boleh' }, 409);
      const finalTag = await h.insert('tags', { epc: '300833B2DDD901400000000B', type: 'STANDARD_LABEL', status: 'IN_STOCK' });
      await h.request('PATCH', `/tags/${finalTag.id}/deactivate`, { reason: 'Tidak boleh' }, 409);
    });
    test('Concurrent duplicate EPC produces exactly one saved tag/item/event', async () => {
      const before = h.events.length;
      const results = await Promise.allSettled([encode('300833B2DDD901400000000C'), encode('300833B2DDD901400000000C')]);
      assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
      assert.equal((await h.repository.all('tags')).filter(t => t.epc === '300833B2DDD901400000000C').length, 1);
      assert.equal(h.events.length, before + 1);
    });
    test('Rollback prevents orphan tag/item and emits no MQTT on persistence failure', async () => {
      const original = h.repository.transaction.bind(h.repository);
      const before = (await h.repository.all('tags')).length, events = h.events.length;
      h.repository.transaction = work => original(async repo => {
        const insert = repo.insert.bind(repo);
        const wrapped = Object.create(repo) as Repository;
        wrapped.insert = async (table, data) => { if (table === 'items') throw new Error('Injected item persistence failure'); return insert(table, data); };
        return work(wrapped);
      });
      try { await h.request('POST', '/tags/encode', { product_id: h.productId }, 500); }
      finally { h.repository.transaction = original; }
      assert.equal((await h.repository.all('tags')).length, before); assert.equal(h.events.length, events);
      const tags = await h.repository.all('tags'), products = await h.repository.all('products');
      for (const item of await h.repository.all('items')) { assert.ok(tags.some(t => t.id === item.tag_id)); assert.ok(products.some(p => p.id === item.product_id)); }
    });
    test('MQTT publisher failure does not invalidate committed registration', async () => {
      const app = Fastify();
      await app.register(orang1InboundRoutes, { repository: h.repository, publish: () => { throw new Error('Broker offline'); } });
      try {
        const response = await app.inject({ method: 'POST', url: '/api/tags/encode', payload: { product_id: h.productId, epc_custom: '300833B2DDD901400000000D' } });
        assert.equal(response.statusCode, 201);
        assert.ok((await h.repository.all('tags')).some(t => t.epc === '300833B2DDD901400000000D'));
      } finally { await app.close(); }
    });
    test('MQTT observer can read both tag and item through a separate committed read', async () => {
      const app = Fastify();
      let observed: Promise<void> | undefined;
      await app.register(orang1InboundRoutes, { repository: h.repository, publish: (_topic, event) => {
        observed = (async () => {
          const tag = await h.repository.get('tags', String(event.tag_id));
          const item = await h.repository.get('items', String(event.item_id));
          assert.equal(tag?.epc, event.epc); assert.equal(item?.product_id, event.product_id);
        })();
      } });
      try {
        const response = await app.inject({ method: 'POST', url: '/api/tags/encode', payload: { product_id: h.productId } });
        assert.equal(response.statusCode, 201); assert.ok(observed); await observed;
      } finally { await app.close(); }
    });
    test('PostgreSQL missing audit migration safely rolls back verification/cancel/deactivate', { skip: kind !== 'postgres' }, async () => {
      const grn = (await h.request('POST', '/inbound/grn', grnBody('TEST-NO-AUDIT'), 201)).data;
      const { tag } = await encode('300833B2DDD901400000000E');
      await h.pool!.query('ALTER TABLE orang1_inbound_audit RENAME TO audit_saved');
      try {
        await h.request('PATCH', `/inbound/grn/${grn.id}/verify`, undefined, 409);
        await h.request('PATCH', `/inbound/grn/${grn.id}/cancel`, { reason: 'No audit' }, 409);
        await h.request('PATCH', `/tags/${tag.id}/deactivate`, { reason: 'No audit' }, 409);
        assert.equal((await h.request('GET', `/inbound/grn/${grn.id}`)).data.status, 'MENUNGGU_VERIFIKASI');
        assert.equal((await h.request('GET', `/tags/${tag.id}`)).data.status, 'ENCODED');
      } finally { await h.pool!.query('ALTER TABLE audit_saved RENAME TO orang1_inbound_audit'); }
    });
    test('PostgreSQL native unit_price/min_stock_threshold and optional default location supported', { skip: kind !== 'postgres' }, async () => {
      await h.pool!.query('ALTER TABLE products RENAME COLUMN price TO unit_price; ALTER TABLE products RENAME COLUMN min_stock_alert TO min_stock_threshold; ALTER TABLE products ADD COLUMN default_location_code VARCHAR(100)');
      try {
        const product = (await h.request('POST', '/products', { ...productBody('TEST-NATIVE-FIELDS'), default_location_code: 'Rak QA' }, 201)).data;
        assert.equal(Number(product.unit_price), 1234.56); assert.equal(product.default_location_code, 'Rak QA');
        await h.request('PUT', `/products/${product.id}`, { ...productBody('TEST-NATIVE-FIELDS'), unit_price: 99, price: 99, default_location_code: 'Rak QA 2' });
        const read = (await h.request('GET', `/products/${product.id}`)).data;
        assert.equal(Number(read.price), 99); assert.equal(read.min_stock_alert, 0); assert.equal(read.default_location_code, 'Rak QA 2');
      } finally { await h.pool!.query('ALTER TABLE products RENAME COLUMN unit_price TO price; ALTER TABLE products RENAME COLUMN min_stock_threshold TO min_stock_alert; ALTER TABLE products DROP COLUMN default_location_code'); }
    });
    test('Original source identities and products remain intact', async () => {
      const product = (await h.request('GET', `/products/${h.productId}`)).data;
      assert.equal(product.id, h.productId); assert.equal(product.sku, 'TEST-ONE'); assert.equal(product.name, 'Produk Pengujian');
    });
    test('Existing tag rack_name contract is retained and located tag cannot be deactivated', async () => {
      const { tag, item } = await encode('300833B2DDD901400000001F');
      const location = await h.insert('locations', { zone_code: 'QA', rack_name: 'Rak QA-01', zone_description: 'QA' });
      await h.repository.transaction(repo => repo.update('items', String(item.id), { location_id: location.id }));
      const detail = (await h.request('GET', `/tags/${tag.id}`)).data;
      assert.equal(detail.rack_name, 'Rak QA-01'); assert.equal(detail.location_id, location.id);
      await h.request('PATCH', `/tags/${tag.id}/deactivate`, { reason: 'Masih di rak' }, 409);
    });
  });
}

test('Memory UUID contract survives deleting all rows and native field updates stay consistent', async () => {
  const source = { products: [{ id: uuid1, sku: 'UUID-ONLY', name: 'UUID', category: 'QA', unit_price: 5, min_stock_threshold: 1 }], tags: [], goods_receipts: [], items: [], stock_movements: [], gate_events: [] };
  const repository = new MemoryRepository(source), app = Fastify();
  await app.register(orang1InboundRoutes, { repository, publish: () => {} });
  try {
    const update = await app.inject({ method: 'PUT', url: `/api/products/${uuid1}`, payload: { ...productBody('UUID-ONLY'), price: 99 } });
    assert.equal(update.statusCode, 200); assert.equal(update.json().data.unit_price, 99);
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/products/${uuid1}` })).statusCode, 200);
    const create = await app.inject({ method: 'POST', url: '/api/products', payload: productBody('UUID-STILL') });
    assert.equal(create.statusCode, 201); assert.match(create.json().data.id, /^[0-9a-f-]{36}$/);
  } finally { await app.close(); }
});
