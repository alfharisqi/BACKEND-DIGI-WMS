import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { startPickingQa } from './qa';
import { qaScenario } from './scenario';

let qa: Awaited<ReturnType<typeof startPickingQa>>;
let fixture: Awaited<ReturnType<typeof qaScenario>>;
before(async () => { qa = await startPickingQa({ inbound: true }); fixture = await qaScenario(qa.pool, 'INBOUND'); });
after(async () => { await qa?.close(); });

const epc = () => randomBytes(12).toString('hex').toUpperCase();
const line = (product_id: string, received_qty: number) => ({ product_id, received_qty });
const header = (lines?: ReturnType<typeof line>[]) => ({ po_number: 'QA-PO-' + randomUUID(), supplier_name: 'Pemasok QA', lines });
const url = '/inbound/grn';
function raw(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', route: string, payload?: object, token = qa.token()) {
  return qa.api.inject({ method, url: '/api' + route, payload, headers: token ? { authorization: 'Bearer ' + token } : {} });
}
async function request(method: Parameters<typeof raw>[0], route: string, payload?: object, status = 200, token?: string) {
  const result = await raw(method, route, payload, token);
  assert.equal(result.statusCode, status, result.body);
  assert.equal(result.json().success, status < 400);
  return result.json().data;
}
async function receipt(lines: ReturnType<typeof line>[], verify = true) {
  const order = await request('POST', url, header(lines), 201);
  return verify ? request('PATCH', `${url}/${order.id}/verify`, { lines, verified_by: randomUUID() }) : order;
}
const input = (order: any, entry = order.lines[0], code = epc()) => ({ grn_id: order.id, grn_line_id: entry.id, epc: code, mode: 'simulation' });

test('warehouse mutations reject missing, invalid and expired JWT, role drift and inactive accounts', async () => {
  const payload = header([line(fixture.products.wanted, 1)]);
  for (const token of ['', 'invalid', qa.token(undefined, { expiresIn: -1 })]) await request('POST', url, payload, 401, token);
  await request('POST', url, payload, 403, qa.token('SECURITY'));
  await request('POST', url, payload, 403, qa.token('ADMIN'));
  await qa.pool.query('UPDATE users SET is_active=false WHERE id=$1', [qa.actor.id]);
  try { await request('POST', url, payload, 403); }
  finally { await qa.pool.query('UPDATE users SET is_active=true WHERE id=$1', [qa.actor.id]); }
  await request('GET', url, undefined, 200, '');
});

test('GRN requires unique positive SKU rows, derives total, preserves header-only history and blocks duplicate PO', async () => {
  const valid = [line(fixture.products.wanted, 10), line(fixture.products.other, 5)];
  await request('POST', url, header(), 400);
  for (const qty of [0, -1, 1.5]) await request('POST', url, header([line(fixture.products.wanted, qty)]), 400);
  await request('POST', url, header([valid[0], valid[0]]), 400);
  await request('POST', url, header([line(randomUUID(), 1)]), 404);
  const payload = { ...header(valid), total_qty: 999 };
  const order = await request('POST', url, payload, 201);
  assert.equal(order.total_qty, 15);
  await request('POST', url, payload, 409);
  const edited = await request('PUT', `${url}/${order.id}`, { ...payload, lines: [line(fixture.products.wanted, 3)] });
  assert.equal(edited.total_qty, 3);
  await assert.rejects(qa.pool.query('UPDATE goods_receipts SET total_qty=2 WHERE id=$1', [order.id]), { code: '23514' });
  const { rows: [legacy] } = await qa.pool.query("INSERT INTO goods_receipts(po_number,supplier_name,total_qty) VALUES ($1,'QA lama',1) RETURNING id", ['QA-LEGACY-' + randomUUID()]);
  assert.deepEqual((await request('GET', `${url}/${legacy.id}`)).lines, []);
  await request('PATCH', `${url}/${legacy.id}/verify`, { lines: valid }, 409);
});

test('verification matches physical counts per SKU and audits the actual actor', async () => {
  const rows = [line(fixture.products.wanted, 2), line(fixture.products.other, 1)];
  const order = await receipt(rows, false);
  await request('POST', '/tags/encode', input(order), 409);
  await request('PATCH', `${url}/${order.id}/verify`, { lines: [rows[0]] }, 409);
  await request('PATCH', `${url}/${order.id}/verify`, { lines: [rows[0], line(fixture.products.other, 2)] }, 409);
  const data = await request('PATCH', `${url}/${order.id}/verify`, { lines: rows, verified_by: randomUUID() });
  assert.equal(data.verified_by, qa.actor.id);
  assert.ok(data.verified_at);
  const view = await request('GET', `${url}/${order.id}`);
  assert.equal(view.audit_history.at(-1).actor_id, qa.actor.id);
  await request('PUT', `${url}/${order.id}`, header(rows), 409);
});

test('wrong SKU, unrelated line, duplicate EPC and last-slot concurrency preserve per-SKU quotas', async () => {
  const order = await receipt([line(fixture.products.wanted, 1), line(fixture.products.other, 1)]);
  const another = await receipt([line(fixture.products.wanted, 1)]);
  const wanted = order.lines.find((entry: any) => entry.product_id === fixture.products.wanted);
  const other = order.lines.find((entry: any) => entry.product_id === fixture.products.other);
  await request('POST', '/tags/encode', input(order, another.lines[0]), 409);
  await request('POST', '/tags/encode', { ...input(order, wanted), product_id: fixture.products.other }, 409);
  const scans = await Promise.all([raw('POST', '/tags/encode', input(order, wanted)), raw('POST', '/tags/encode', input(order, wanted))]);
  assert.deepEqual(scans.map(result => result.statusCode).sort(), [201, 409]);
  const tag = scans.find(result => result.statusCode === 201)!.json().data;
  assert.equal(tag.mode, 'simulation'); assert.equal(tag.hardware_confirmed, false);
  assert.equal(tag.item.grn_line_id, wanted.id); assert.equal(tag.tag.encoded_by, qa.actor.id);
  await request('POST', '/tags/encode', input(order, other, tag.tag.epc), 409);
  const partial = await request('GET', `${url}/${order.id}`);
  assert.deepEqual(partial.tagging_progress, { tagged: 1, total: 2 });
  await request('POST', '/tags/encode', input(order, other), 201);
  const complete = await request('GET', `${url}/${order.id}`);
  assert.equal(complete.rfid_tagging_status, 'SELESAI_TAGGING');
  assert.deepEqual(complete.lines.map((row: any) => row.tagged_qty), [1, 1]);
});

test('supervisor correction preserves old EPC, reopens quota and rejects correction after actual Putaway', async () => {
  const order = await receipt([line(fixture.products.wanted, 1)]);
  const original = await request('POST', '/tags/encode', input(order), 201);
  const deactivate = `/tags/${original.tag.id}/deactivate`;
  const replace = `/tags/${original.tag.id}/replace`;
  await request('PATCH', deactivate, { reason: 'QA rusak' }, 403);
  await qa.pool.query("UPDATE users SET role='SUPERVISOR' WHERE id=$1", [qa.actor.id]);
  const supervisor = qa.token('SUPERVISOR');
  try {
    await request('POST', replace, { reason: 'QA rusak', epc: original.tag.epc }, 409, supervisor);
    assert.equal((await request('GET', `/tags/${original.tag.id}`)).status, 'ENCODED');
    const next = await request('POST', replace, { reason: 'QA rusak' }, 201, supervisor);
    assert.equal((await request('GET', `/tags/${original.tag.id}`)).status, 'DAMAGED');
    await request('POST', '/tags/encode', input(order, order.lines[0], original.tag.epc), 409, supervisor);
    assert.equal((await request('GET', `${url}/${order.id}`)).tagging_progress.tagged, 1);
    const put = { epc: next.tag.epc, location_code: fixture.code, reference_doc: order.po_number };
    await request('POST', '/inventory/putaway', put, 201, supervisor);
    await request('POST', '/inventory/putaway', put, 409, supervisor);
    await request('PATCH', `/tags/${next.tag.id}/deactivate`, { reason: 'QA setelah Putaway' }, 409, supervisor);
    const stock = await request('GET', '/inventory/stock-by-rack');
    assert.ok(stock.some((row: any) => row.rack_code === fixture.code && row.product_id === fixture.products.wanted && row.quantity === 1));
    const { rows: [ledger] } = await qa.pool.query("SELECT count(*)::int AS n FROM stock_movements WHERE tag_id=$1 AND movement_type='PUTAWAY'", [next.tag.id]);
    assert.equal(ledger.n, 1);
  } finally { await qa.pool.query("UPDATE users SET role='WAREHOUSE_STAFF' WHERE id=$1", [qa.actor.id]); }
});

test('eligible supervisors may choose an explicit non-GRN purpose and cancel an unused draft', async () => {
  const payload = { product_id: fixture.products.wanted, mode: 'simulation' };
  await request('POST', '/tags/encode', payload, 400);
  await request('POST', '/tags/encode', { ...payload, inbound_purpose: 'ASSET' }, 403);
  await qa.pool.query("UPDATE users SET role='ADMIN' WHERE id=$1", [qa.actor.id]);
  const admin = qa.token('ADMIN');
  try {
    const tag = await request('POST', '/tags/encode', { ...payload, inbound_purpose: 'ASSET' }, 201, admin);
    assert.equal(tag.item.inbound_purpose, 'ASSET');
    assert.equal(tag.item.grn_id, null);
    const order = await request('POST', url, header([line(fixture.products.wanted, 1)]), 201, admin);
    const cancelled = await request('PATCH', `${url}/${order.id}/cancel`, { reason: 'QA batal' }, 200, admin);
    assert.equal(cancelled.status, 'DIBATALKAN');
  } finally { await qa.pool.query("UPDATE users SET role='WAREHOUSE_STAFF' WHERE id=$1", [qa.actor.id]); }
});

test('failing tag audit rolls back both tag and item, preserving the slot', async () => {
  const order = await receipt([line(fixture.products.wanted, 1)]);
  const failure = input(order);
  await qa.pool.query(`CREATE FUNCTION qa_fail_inbound_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'Failed synthetic inbound audit'; END $$;
    CREATE TRIGGER qa_fail_inbound_audit BEFORE INSERT ON orang1_inbound_audit
      FOR EACH ROW WHEN (NEW.action='ENCODE_SIMULATION') EXECUTE FUNCTION qa_fail_inbound_audit()`);
  try {
    await request('POST', '/tags/encode', failure, 500);
    assert.equal((await request('GET', `${url}/${order.id}`)).tagging_progress.tagged, 0);
    assert.equal((await qa.pool.query('SELECT 1 FROM tags WHERE epc=$1', [failure.epc])).rowCount, 0);
  } finally {
    await qa.pool.query('DROP TRIGGER qa_fail_inbound_audit ON orang1_inbound_audit; DROP FUNCTION qa_fail_inbound_audit()');
  }
  await request('POST', '/tags/encode', failure, 201);
});
