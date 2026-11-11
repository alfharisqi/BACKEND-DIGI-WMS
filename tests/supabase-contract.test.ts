import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { createSupabaseQa } from './qa-supabase';
import { orang1InboundRoutes } from '../src/modules/orang1-inbound/routes';

for (const expanded of [false, true]) describe(`Supabase UUID contract / ${expanded ? 'QA capability statuses' : 'exact Production status constraints'}`, { skip: !process.env.ORANG1_TEST_DATABASE_URL }, () => {
  let qa: Awaited<ReturnType<typeof createSupabaseQa>>, app: ReturnType<typeof Fastify>;
  const events: any[] = [];
  before(async () => { qa = await createSupabaseQa(expanded); app = Fastify(); await app.register(orang1InboundRoutes, { repository: qa.repository, publish: (topic, payload) => events.push({ topic, payload }) }); });
  after(async () => { await app?.close(); await qa?.close(); });
  const request = async (method: any, path: string, payload?: any, expected = 200) => {
    const response = await app.inject({ method, url: `/api${path}`, payload }); const json = response.json();
    assert.equal(response.statusCode, expected, JSON.stringify(json)); assert.equal(json.success, expected < 400); return json.data;
  };
  const grn = (po: string) => request('POST', '/inbound/grn', { po_number: po, supplier_name: 'QA Supplier', total_qty: 2 }, 201);
  const encode = (extra = {}) => request('POST', '/tags/encode', { product_id: qa.product.id, type: 'ON_METAL', ...extra }, 201);

  test('Stock preserves source projection despite incomplete ledger without product UUID', async () => {
    await qa.pool.query("INSERT INTO stock_movements(tx_code,movement_type,sku,from_location,to_location,qty_change,qty_label) VALUES ('QA-STOCK','INBOUND_GRN',$1,'Supplier','QA',50,'+50')", [qa.product.sku]);
    const row = await request('GET', `/products/${qa.product.id}`);
    assert.equal(row.current_stock, 15); assert.equal(row.stock_source, 'products.current_stock');
    await request('PUT', `/products/${qa.product.id}`, { sku: 'SHOULD-NOT-RENAME', name: qa.product.name, category: 'QA', price: 650000 }, 409);
  });
  test('Positive stored stock prevents deletion even without item/ledger relations', async () => {
    const row = (await qa.pool.query("INSERT INTO products(sku,name,category,current_stock) VALUES ('QA-POSITIVE','QA Positive','QA',7) RETURNING *")).rows[0];
    await request('DELETE', `/products/${row.id}`, undefined, 409);
  });
  test('SKU create/update/delete persists native fields and UUID', async () => {
    const body = { sku: 'QA-NEW', name: 'QA New', category: 'QA', price: 1200, min_stock_alert: 3, default_location_code: 'QA-RACK' };
    const row = await request('POST', '/products', body, 201); assert.match(row.id, /^[0-9a-f-]{36}$/);
    const updated = await request('PUT', `/products/${row.id}`, { ...body, price: 1300 });
    assert.equal(updated.id, row.id); assert.equal(Number(updated.unit_price), 1300); assert.equal(updated.min_stock_threshold, 3);
    await request('DELETE', `/products/${row.id}`); await request('GET', `/products/${row.id}`, undefined, 404);
  });
  test('Tag type mapping writes Supabase label and item remains ENCODED before putaway', async () => {
    const result = await encode();
    assert.equal(result.tag.type, 'ON_METAL'); assert.equal(result.tag.tag_type, 'On-Metal (Logam/Cairan)');
    assert.equal(result.item.status, 'ENCODED'); assert.equal(result.item.product_id, qa.product.id);
    assert.equal(result.hardware_confirmed, false); assert.equal(events.at(-1).payload.product_id, qa.product.id);
    const row = await request('GET', `/tags/${result.tag.id}`); assert.equal(row.type, 'ON_METAL');
    await request('PATCH', `/tags/${row.id}`, { type: 'HARD_TAG', product_id: qa.other.id });
    assert.equal((await request('GET', `/tags/${row.id}`)).tag_type, 'Hard Tag (Aset)');
  });
  test('Legacy EPC is readable unchanged and rejected for new registration', async () => {
    const tag = (await qa.pool.query("INSERT INTO tags(epc,tag_type,status) VALUES ('E280-1160-2000-012A','Label Biasa (UHF)','IN_STOCK') RETURNING *")).rows[0];
    assert.equal((await request('GET', `/tags/${tag.id}`)).epc, tag.epc);
    assert.ok((await request('GET', '/tags')).some((row: any) => row.id === tag.id && row.type === 'STANDARD_LABEL'));
    await request('POST', '/tags/encode', { product_id: qa.product.id, epc_custom: tag.epc }, 400);
  });
  test('GRN verify records verified_at and audit, keeps RFID waiting', async () => {
    const row = await grn('QA-VERIFY'); const verified = await request('PATCH', `/inbound/grn/${row.id}/verify`);
    assert.ok(verified.verified_at); assert.equal(verified.status, 'SELESAI'); assert.equal(verified.rfid_tagging_status, 'MENUNGGU_TAGGING');
    const detail = await request('GET', `/inbound/grn/${row.id}`); assert.equal(detail.audit_history.at(-1).action, 'VERIFY');
    await request('PATCH', `/inbound/grn/${row.id}/verify`, undefined, 409);
  });
  test('GRN calendar date remains YYYY-MM-DD in create/update/detail/list without timezone shift', async () => {
    const body = { po_number: 'QA-DATE', supplier_name: 'QA Supplier', receipt_date: '2026-05-12', total_qty: 1 };
    const row = await request('POST', '/inbound/grn', body, 201); assert.equal(row.receipt_date, '2026-05-12');
    const updated = await request('PUT', `/inbound/grn/${row.id}`, { ...body, receipt_date: '2026-11-09' }); assert.equal(updated.receipt_date, '2026-11-09');
    assert.equal((await request('GET', `/inbound/grn/${row.id}`)).receipt_date, '2026-11-09');
    assert.equal((await request('GET', '/inbound/grn')).find((g: any) => g.id === row.id).receipt_date, '2026-11-09');
  });
  test('Cancel/deactivate persist only when schema supports them; exact Production fails clearly without writes', async () => {
    const row = await grn('QA-CANCEL'), result = await encode();
    const count = (await qa.pool.query('SELECT COUNT(*)::int AS total FROM orang1_inbound_audit')).rows[0].total;
    if (expanded) {
      const cancelled = await request('PATCH', `/inbound/grn/${row.id}/cancel`, { reason: 'QA cancellation' }); assert.equal(cancelled.status, 'DIBATALKAN');
      const damaged = await request('PATCH', `/tags/${result.tag.id}/deactivate`, { reason: 'QA damaged' }); assert.equal(damaged.status, 'DAMAGED');
      assert.equal((await request('GET', `/tags/${damaged.id}`)).audit_history.at(-1).reason, 'QA damaged');
      assert.equal((await request('GET', `/inbound/grn/${row.id}`)).status, 'DIBATALKAN');
    } else {
      const response = await app.inject({ method: 'PATCH', url: `/api/inbound/grn/${row.id}/cancel`, payload: { reason: 'QA reject' } });
      assert.equal(response.statusCode, 409); assert.match(response.json().message, /belum mendukung status DIBATALKAN/);
      const deactivate = await app.inject({ method: 'PATCH', url: `/api/tags/${result.tag.id}/deactivate`, payload: { reason: 'QA reject' } });
      assert.equal(deactivate.statusCode, 409); assert.match(deactivate.json().message, /belum mendukung status DAMAGED/);
      assert.equal((await request('GET', `/tags/${result.tag.id}`)).status, 'ENCODED');
      assert.equal((await qa.pool.query('SELECT COUNT(*)::int AS total FROM orang1_inbound_audit')).rows[0].total, count);
    }
  });
  test('Ledger tag_id and item transaction status prevent reassignment/deactivation', async () => {
    const result = await encode();
    await qa.pool.query("INSERT INTO stock_movements(tx_code,movement_type,product_id,sku,tag_id,from_location,to_location,qty_change,qty_label) VALUES ('QA-TAG-TX','PICKING',$1,$2,$3,'QA','QA',-1,'-1')", [qa.product.id, qa.product.sku, result.tag.id]);
    await request('PATCH', `/tags/${result.tag.id}`, { product_id: qa.other.id }, 409);
    await request('PATCH', `/tags/${result.tag.id}/deactivate`, { reason: 'Blocked' }, 409);
    const next = await encode(); await qa.pool.query("UPDATE items SET status='IN_STOCK' WHERE id=$1", [next.item.id]);
    await request('PATCH', `/tags/${next.tag.id}`, { product_id: qa.other.id }, 409);
  });
  test('Unassigned tag transition creates linked ENCODED item using UUID defaults', async () => {
    const tag = (await qa.pool.query("INSERT INTO tags(epc,status) VALUES ('300833B2DDD9014000000077','UNASSIGNED') RETURNING *")).rows[0];
    await request('PATCH', `/tags/${tag.id}`, { status: 'ENCODED', product_id: qa.other.id });
    const item = (await qa.pool.query('SELECT * FROM items WHERE tag_id=$1', [tag.id])).rows[0]; assert.equal(item.status, 'ENCODED'); assert.equal(item.product_id, qa.other.id);
  });
});
