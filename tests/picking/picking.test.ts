import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { packingFields } from '../../src/modules/orang1-picking/contract';
import { startPickingQa } from './qa';
import { qaScenario } from './scenario';

let qa: Awaited<ReturnType<typeof startPickingQa>>;
before(async () => {
  qa = await startPickingQa();
  console.log(`PostgreSQL QA ${qa.version}: data_directory dan alamat loopback terverifikasi. Migrasi 002 diterapkan pada fixture sintetis.`);
});
after(async () => { if (qa) await qa.close(); });

const unknownEpc = () => randomBytes(12).toString('hex').toUpperCase();
const header = (token = qa.token()) => ({ authorization: `Bearer ${token}` });
const list = (query = '') => qa.api.inject({ method: 'GET', url: '/api/picking/orders' + query, headers: header() });
const scan = (order: string, epc: string) => qa.api.inject({
  method: 'POST', url: '/api/picking/scan', headers: header(), payload: { order_id: order, epc },
});
async function sample(name: string, qty = 2) {
  const fixture = await qaScenario(qa.pool, name, qty);
  return { ...fixture, target: await fixture.order('01') };
}
function check(response: { statusCode: number; json: () => any }, code: number, message?: RegExp) {
  assert.equal(response.statusCode, code, JSON.stringify(response.json()));
  const body = response.json();
  assert.equal(body.success, code < 400);
  if (message) assert.match(body.message, message);
  return body.data;
}

test('GET empty orders returns 200 and an empty array', async () => {
  assert.deepEqual(check(await list(), 200), []);
});

test('Migration installs UUID relations, RLS and unique active reservation indexes', async () => {
  const { rows } = await qa.pool.query(`
    SELECT c.relname, c.relrowsecurity, has_table_privilege('anon', c.oid, 'SELECT') AS anon,
      has_table_privilege('authenticated', c.oid, 'INSERT') AS authenticated,
      has_table_privilege('service_role', c.oid, 'SELECT') AS service
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname IN ('picking_orders', 'picking_order_lines', 'picking_scans')
  `);
  assert.equal(rows.length, 3);
  assert.ok(rows.every(row => row.relrowsecurity && !row.anon && !row.authenticated && !row.service));
  const indexes = await qa.pool.query("SELECT indexdef FROM pg_indexes WHERE schemaname='public' AND indexname LIKE 'picking_scans_active_%'");
  assert.equal(indexes.rowCount, 2);
  assert.ok(indexes.rows.every(row => /CREATE UNIQUE INDEX.*WHERE \(released_at IS NULL\)/.test(row.indexdef)));
  const types = await qa.pool.query("SELECT udt_name FROM information_schema.columns WHERE table_schema='public' AND table_name='picking_scans' AND column_name IN ('id','order_id','product_id','item_id','tag_id','location_id','scanned_by')");
  assert.deepEqual(types.rows.map(row => row.udt_name), Array(7).fill('uuid'));
});

test('GET real order, SKU, quantity and progress', async () => {
  const f = await sample('LIST');
  const order = check(await list(), 200).find((row: any) => row.id === f.target.id);
  assert.equal(order.order_number, f.target.number);
  assert.equal(order.status, 'MENUNGGU_PICKING');
  assert.equal(order.requested_qty, 2);
  assert.equal(order.picked_qty, 0);
  assert.equal(order.lines[0].sku, f.sku);
  assert.equal(order.lines[0].product_name, f.productName);
});

test('GET filter only returns orders at the requested status', async () => {
  const f = await sample('FILTER');
  const ready = await f.order('READY', [{ productId: f.products.wanted, qty: 1 }]);
  const tag = await f.item();
  check(await scan(ready.id, tag.epc), 200);
  const results = check(await list('?status=MENUNGGU_PICKING'), 200);
  assert.ok(results.some((row: any) => row.id === f.target.id));
  assert.ok(!results.some((row: any) => row.id === ready.id));
  assert.ok(results.every((row: any) => row.status === 'MENUNGGU_PICKING'));
  check(await list('?status=UNKNOWN'), 400, /Status/);
});

test('GET rack comes from item location and excludes unavailable, transit and reservations', async () => {
  const f = await sample('RACK');
  const a = await f.item();
  await f.item();
  await f.item({ locationId: f.racks.alternate });
  await f.item({ locationId: f.racks.transit });
  await f.item({ locationId: null });
  await f.item({ itemStatus: 'ENCODED' });
  await f.item({ tagStatus: 'RESERVED' });
  const expected = [{ id: f.racks.alternate, available_qty: 1 }, { id: f.racks.main, available_qty: 2 }];
  function racks(response: Awaited<ReturnType<typeof list>>) {
    const order = check(response, 200).find((row: any) => row.id === f.target.id);
    return order.lines[0].locations;
  }
  const beforeScan = racks(await list());
  assert.deepEqual(beforeScan.map(({ id, available_qty }: any) => ({ id, available_qty })), expected);
  assert.equal(beforeScan[1].code, f.code);
  assert.equal(beforeScan[1].name, 'Rak Fisik QA');
  check(await scan(f.target.id, a.epc), 200);
  assert.equal(racks(await list())[1].available_qty, 1);
});

test('POST valid scan persists RESERVED, audit, partial progress and keeps ledger and stock intact', async () => {
  const f = await sample('RESERVE');
  const item = await f.item();
  const state = () => qa.pool.query(`
    SELECT t.status AS tag_status, i.status AS item_status, p.current_stock, i.location_id,
      (SELECT count(*)::int FROM stock_movements) AS ledger_count,
      (SELECT count(*)::int FROM stock_movements WHERE movement_type='OUTBOUND_SHIPMENT') AS outbound_count
    FROM items i JOIN tags t ON t.id=i.tag_id JOIN products p ON p.id=i.product_id WHERE i.id=$1`, [item.id]).then(r => r.rows[0]);
  const initial = await state();
  assert.equal(initial.tag_status, 'IN_STOCK');
  assert.equal(initial.item_status, 'IN_STOCK');
  const forgedActor = randomUUID();
  const result = check(await qa.api.inject({ method: 'POST', url: '/api/picking/scan', headers: header(),
    payload: { order_id: f.target.id, epc: item.epc.toLowerCase(), scanned_by: forgedActor, actor_id: forgedActor },
  }), 200);
  assert.equal(result.tag_status, 'RESERVED');
  assert.equal(result.item_status, 'RESERVED');
  assert.equal(result.order.status, 'SEDANG_DIAMBIL');
  assert.equal(result.order.picked_qty, 1);
  assert.equal(result.order.requested_qty, 2);
  assert.equal(result.scan.location_code, f.code);
  assert.deepEqual(await state(), { ...initial, tag_status: 'RESERVED', item_status: 'RESERVED' });
  const audit = (await qa.pool.query("SELECT * FROM picking_scans WHERE order_id=$1", [f.target.id])).rows;
  assert.equal(audit.length, 1);
  assert.equal(audit[0].item_id, item.id);
  assert.equal(audit[0].tag_id, item.tagId);
  assert.equal(audit[0].product_id, f.products.wanted);
  assert.equal(audit[0].scanned_by, qa.actor.id);
  assert.equal(audit[0].location_id, f.racks.main);
  assert.equal(audit[0].epc, item.epc);
  assert.equal(audit[0].released_at, null);
  assert.equal(check(await list('?status=SEDANG_DIAMBIL'), 200).find((row: any) => row.id === f.target.id).lines[0].scans[0].epc, item.epc);
});

test('POST wrong SKU returns 409 and preserves available tag', async () => {
  const f = await sample('WRONG');
  const item = await f.item({ productId: f.products.other });
  check(await scan(f.target.id, item.epc), 409, /tidak sesuai/);
  assert.equal((await qa.pool.query('SELECT status FROM tags WHERE id=$1', [item.tagId])).rows[0].status, 'IN_STOCK');
});

test('POST unknown EPC returns 404', async () => {
  const f = await sample('UNKNOWN');
  check(await scan(f.target.id, unknownEpc()), 404, /tidak terdaftar/);
});

test('POST RESERVED tag returns 409, even if the item is IN_STOCK', async () => {
  const f = await sample('RESERVED');
  check(await scan(f.target.id, (await f.item({ tagStatus: 'RESERVED' })).epc), 409, /IN_STOCK/);
});

test('POST unknown order returns 404', async () => {
  check(await scan(randomUUID(), unknownEpc()), 404, /Pesanan/);
});

test('POST malformed EPC returns 400', async () => {
  check(await scan(randomUUID(), 'EPC-GAGAL'), 400, /EPC/);
});

test('POST malformed order UUID returns 400', async () => {
  check(await scan('27', unknownEpc()), 400, /UUID/);
});

test('POST non-IN_STOCK item returns 409, even if the tag is IN_STOCK', async () => {
  const f = await sample('ITEM');
  check(await scan(f.target.id, (await f.item({ itemStatus: 'ENCODED' })).epc), 409, /IN_STOCK/);
});

test('POST EPC without an assigned unit returns 409', async () => {
  const f = await sample('NOITEM');
  check(await scan(f.target.id, (await f.item({ link: false })).epc), 409, /unit/);
});

test('POST rejects transit or missing physical rack', async () => {
  const f = await sample('NORACK');
  for (const locationId of [null, f.racks.transit]) {
    check(await scan(f.target.id, (await f.item({ locationId })).epc), 409, /rak/);
  }
});

test('POST rejects scans beyond one SKU limit while other SKU remains pending', async () => {
  const f = await sample('LIMIT');
  const order = await f.order('MULTI', [{ productId: f.products.wanted, qty: 1 }, { productId: f.products.other, qty: 1 }]);
  const one = await f.item();
  const extra = await f.item();
  const two = await f.item({ productId: f.products.other });
  assert.equal(check(await scan(order.id, one.epc), 200).order.status, 'SEDANG_DIAMBIL');
  check(await scan(order.id, extra.epc), 409, /Kuantitas SKU/);
  const result = check(await scan(order.id, two.epc), 200);
  assert.equal(result.order.status, 'SIAP_PACKING');
  assert.equal(result.order.picked_qty, 2);
  check(await scan(order.id, extra.epc), 409, /Seluruh kuantitas/);
});

test('POST repeating the same EPC is rejected and creates no duplicate scan', async () => {
  const f = await sample('REPEAT');
  const item = await f.item();
  check(await scan(f.target.id, item.epc), 200);
  check(await scan(f.target.id, item.epc), 409, /sudah dipindai/);
  assert.equal((await qa.pool.query('SELECT count(*)::int AS qty FROM picking_scans WHERE item_id=$1', [item.id])).rows[0].qty, 1);
});

test('Simultaneous scans for different orders reserve an EPC only once', async () => {
  const f = await sample('RACE');
  const second = await f.order('02');
  const item = await f.item();
  const responses = await Promise.all([scan(f.target.id, item.epc), scan(second.id, item.epc)]);
  assert.deepEqual(responses.map(r => r.statusCode).sort(), [200, 409]);
  assert.equal((await qa.pool.query('SELECT count(*)::int AS qty FROM picking_scans WHERE tag_id=$1 AND released_at IS NULL', [item.tagId])).rows[0].qty, 1);
});

test('Simultaneous distinct EPCs cannot overfill the last order unit', async () => {
  const f = await sample('LAST', 1);
  const one = await f.item(), two = await f.item();
  const responses = await Promise.all([scan(f.target.id, one.epc), scan(f.target.id, two.epc)]);
  assert.deepEqual(responses.map(r => r.statusCode).sort(), [200, 409]);
  assert.equal((await qa.pool.query("SELECT count(*)::int AS qty FROM tags WHERE id=ANY($1) AND status='RESERVED'", [[one.tagId, two.tagId]])).rows[0].qty, 1);
});

test('Database error after writes rolls back tag, item, scan audit and order', async () => {
  const f = await sample('ROLLBACK');
  const item = await f.item();
  await qa.pool.query(`
    CREATE FUNCTION qa_picking_fail_order_update() RETURNS trigger LANGUAGE plpgsql AS
    $$ BEGIN RAISE EXCEPTION 'synthetic QA order update failure'; END $$;
    CREATE TRIGGER qa_picking_fail_update BEFORE UPDATE ON picking_orders
    FOR EACH ROW EXECUTE FUNCTION qa_picking_fail_order_update()`);
  try {
    check(await scan(f.target.id, item.epc), 500, /gagal/);
    const row = (await qa.pool.query(`
      SELECT t.status AS tag_status, i.status AS item_status, o.status AS order_status,
        (SELECT count(*)::int FROM picking_scans WHERE order_id=o.id) AS scans
      FROM items i JOIN tags t ON t.id=i.tag_id CROSS JOIN picking_orders o WHERE i.id=$1 AND o.id=$2`,
    [item.id, f.target.id])).rows[0];
    assert.deepEqual(row, { tag_status: 'IN_STOCK', item_status: 'IN_STOCK', order_status: 'MENUNGGU_PICKING', scans: 0 });
  } finally {
    await qa.pool.query('DROP TRIGGER qa_picking_fail_update ON picking_orders; DROP FUNCTION qa_picking_fail_order_update()');
  }
  check(await scan(f.target.id, item.epc), 200);
});

test('Missing Picking schema returns 503 with no fallback order data', async () => {
  await qa.pool.query('ALTER TABLE picking_orders RENAME TO qa_picking_orders');
  try { check(await list(), 503, /Database/); }
  finally { await qa.pool.query('ALTER TABLE qa_picking_orders RENAME TO picking_orders'); }
});

test('GET and POST Picking reject missing, invalid and expired JWT and non-warehouse roles', async () => {
  const f = await sample('JWT');
  const item = await f.item();
  const [jwtHeader, jwtPayload, jwtSignature] = qa.token().split('.');
  const wrongSignature = `${jwtSignature.startsWith('A') ? 'B' : 'A'}${jwtSignature.slice(1)}`;
  const tampered = `${jwtHeader}.${jwtPayload}.${wrongSignature}`;
  for (const [token, status] of [[undefined, 401], ['invalid', 401], [tampered, 401], [qa.token(undefined, { expiresIn: -1 }), 401],
    [qa.token('KASIR_POS'), 403], [qa.token(undefined, undefined, randomUUID()), 403]] as const) {
    const headers = token ? header(token) : {};
    check(await qa.api.inject({ url: '/api/picking/orders', headers }), status);
    check(await qa.api.inject({ method: 'POST', url: '/api/picking/scan', headers, payload: { order_id: f.target.id, epc: item.epc } }), status);
  }
  assert.equal((await qa.pool.query('SELECT 1 FROM picking_scans WHERE order_id=$1', [f.target.id])).rowCount, 0);
  check(await list(), 200);
  check(await scan(f.target.id, item.epc), 200);
});

test('Tokens issued before account deactivation or role change cannot expose order details or mutate Picking/Packing', async () => {
  const f = await sample('REVOKED');
  const item = await f.item();
  const issued = qa.token();
  const orderDetail = `/api/picking/orders/${f.target.id}`;
  const requests = (headers: ReturnType<typeof header>) => [
    qa.api.inject({ url: '/api/picking/orders', headers }),
    qa.api.inject({ url: `${orderDetail}/packing`, headers }),
    qa.api.inject({ method: 'POST', url: '/api/picking/scan', headers, payload: { order_id: f.target.id, epc: item.epc } }),
    qa.api.inject({ method: 'PATCH', url: `${orderDetail}/packing-checklist`, headers, payload: { revision: 0,
      checklist: Object.fromEntries(packingFields.map(field => [field, true])),
    } }),
    qa.api.inject({ method: 'POST', url: `${orderDetail}/packing-complete`, headers, payload: { revision: 0 } }),
  ];
  check(await qa.api.inject({ url: `${orderDetail}/packing`, headers: header(issued) }), 200);
  try {
    for (const [active, role] of [[false, 'WAREHOUSE_STAFF'], [true, 'KASIR_POS'], [true, 'SUPERVISOR']] as const) {
      await qa.pool.query('UPDATE users SET is_active=$1, role=$2 WHERE id=$3', [active, role, qa.actor.id]);
      for (const response of await Promise.all(requests(header(issued)))) {
        assert.equal(check(response, 403), undefined);
      }
    }
    const state = (await qa.pool.query(`SELECT t.status AS tag, i.status AS item, o.status AS order_status,
        (SELECT count(*)::int FROM picking_scans WHERE order_id=o.id) AS scans,
        (SELECT count(*)::int FROM picking_packing_events WHERE order_id=o.id) AS events
      FROM tags t JOIN items i ON t.id=i.tag_id CROSS JOIN picking_orders o WHERE i.id=$1 AND o.id=$2`,
    [item.id, f.target.id])).rows[0];
    assert.deepEqual(state, { tag: 'IN_STOCK', item: 'IN_STOCK', order_status: 'MENUNGGU_PICKING', scans: 0, events: 0 });
    const fresh = header(qa.token('SUPERVISOR'));
    check(await qa.api.inject({ url: '/api/picking/orders', headers: fresh }), 200);
    check(await qa.api.inject({ method: 'POST', url: '/api/picking/scan', headers: fresh, payload: { order_id: f.target.id, epc: item.epc } }), 200);
  } finally {
    await qa.pool.query('UPDATE users SET is_active=true, role=$1 WHERE id=$2', [qa.actor.role, qa.actor.id]);
  }
});

test('Existing grouped legacy EPC can be scanned without changing stored identity', async () => {
  const f = await sample('LEGACY');
  const legacy = 'E280-1160-2000-012A';
  const item = await f.item({ epc: legacy });
  const result = check(await scan(f.target.id, legacy.toLowerCase()), 200);
  assert.equal(result.scan.epc, legacy);
  assert.equal(result.scan.tag_id, item.tagId);
});
