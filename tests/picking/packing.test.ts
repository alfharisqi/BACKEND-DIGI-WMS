import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { packingFields } from '../../src/modules/orang1-picking/contract';
import { startPickingQa } from './qa';
import { qaScenario } from './scenario';

let qa: Awaited<ReturnType<typeof startPickingQa>>;
before(async () => { qa = await startPickingQa(); });
after(async () => { if (qa) await qa.close(); });

const all = Object.fromEntries(packingFields.map(field => [field, true]));
const url = (id: string, suffix: string) => `/api/picking/orders/${id}/${suffix}`;
const headers = (role?: string) => ({ authorization: `Bearer ${qa.token(role)}` });
const view = (id: string) => qa.api.inject({ url: url(id, 'packing'), headers: headers() });
const save = (id: string, revision = 0, checklist = all, role?: string) => qa.api.inject({
  method: 'PATCH', url: url(id, 'packing-checklist'), headers: headers(role), payload: { revision, checklist },
});
const finish = (id: string, revision = 1) => qa.api.inject({
  method: 'POST', url: url(id, 'packing-complete'), headers: headers(), payload: { revision },
});
const scan = (id: string, epc: string) => qa.api.inject({
  method: 'POST', url: '/api/picking/scan', headers: headers(), payload: { order_id: id, epc },
});
function check(response: { statusCode: number; json: () => any }, code: number) {
  assert.equal(response.statusCode, code, JSON.stringify(response.json()));
  assert.equal(response.json().success, code < 400);
  return response.json().data;
}
async function sample(name: string, quantity = 1) {
  const scenario = await qaScenario(qa.pool, name, quantity);
  return { ...scenario, order: await scenario.order('01') };
}
async function picked(name: string) {
  const scenario = await sample(name);
  const item = await scenario.item();
  check(await scan(scenario.order.id, item.epc), 200);
  return { ...scenario, unit: item };
}
async function events(orderId: string) {
  return (await qa.pool.query(`SELECT action,actor_id,checklist,revision FROM picking_packing_events
    WHERE order_id=$1 ORDER BY revision`, [orderId])).rows;
}

test('read-only detail exposes real picking history without creating checklist or audit rows', async () => {
  const f = await picked('DETAIL-PACK');
  const result = check(await view(f.order.id), 200);
  assert.equal(result.order.order_number, f.order.number);
  assert.equal(result.order.lines[0].sku, f.sku);
  assert.equal(result.order.lines[0].requested_qty, 1);
  assert.equal(result.order.lines[0].scans[0].location_id, f.racks.main);
  assert.equal(result.order.lines[0].scans[0].epc, f.unit.epc);
  assert.equal(result.order.lines[0].scans[0].scanned_by, qa.actor.id);
  assert.ok(result.order.lines[0].scans[0].scanned_at);
  assert.equal(result.revision, 0);
  const rows = await qa.pool.query('SELECT 1 FROM picking_packing WHERE order_id=$1', [f.order.id]);
  assert.equal(rows.rowCount, 0);
  assert.deepEqual(await events(f.order.id), []);
});

test('incomplete Picking blocks both checklist writes and finalization', async () => {
  const f = await sample('INCOMPLETE-PACK', 2);
  check(await scan(f.order.id, (await f.item()).epc), 200);
  assert.equal(check(await view(f.order.id), 200).picking_complete, false);
  check(await save(f.order.id), 409);
  check(await finish(f.order.id, 0), 409);
  assert.deepEqual(await events(f.order.id), []);
});

test('Packing requires an active reservation for every SKU and rejects a released scan', async () => {
  const f = await qaScenario(qa.pool, 'ACT-PACK');
  const order = await f.order('MULTI', [{ productId: f.products.wanted, qty: 1 }, { productId: f.products.other, qty: 1 }]);
  const first = await f.item();
  const second = await f.item({ productId: f.products.other });
  check(await scan(order.id, first.epc), 200);
  check(await save(order.id), 409);
  check(await scan(order.id, second.epc), 200);
  check(await save(order.id), 200);
  await qa.pool.query('UPDATE picking_scans SET released_at=now() WHERE order_id=$1 AND epc=$2', [order.id, second.epc]);
  assert.equal(check(await view(order.id), 200).picking_complete, false);
  check(await finish(order.id), 409);
  assert.deepEqual((await events(order.id)).map(event => event.action), ['CHECKLIST_SAVED']);
});

test('checklist persists, supports unchecking and refuses premature finalization', async () => {
  const f = await picked('SAVE-PACK');
  const first = check(await save(f.order.id), 200);
  assert.equal(first.checked_by, qa.actor.id);
  assert.ok(first.updated_at);
  const changed = { ...all, packaging_checked: false };
  check(await save(f.order.id, 1, changed), 200);
  const read = check(await view(f.order.id), 200);
  assert.deepEqual(read.checklist, changed);
  assert.equal(read.revision, 2);
  check(await finish(f.order.id, 2), 409);
  assert.deepEqual((await events(f.order.id)).map(event => event.checklist), [all, changed]);
});

test('concurrent checklist revisions reject lost update', async () => {
  const f = await picked('RACE-PACK');
  const partial = { ...all, condition_checked: false };
  const responses = await Promise.all([save(f.order.id, 0, all), save(f.order.id, 0, partial)]);
  assert.deepEqual(responses.map(response => response.statusCode).sort(), [200, 409]);
  const winner = responses.find(response => response.statusCode === 200)!;
  assert.deepEqual(check(await view(f.order.id), 200).checklist, check(winner, 200).checklist);
  assert.equal((await events(f.order.id)).length, 1);
});

test('concurrent finalization is idempotent, locks checklist and preserves stock and reservation', async () => {
  const f = await picked('FINISH-PACK');
  const order = f.order.id;
  check(await save(order), 200);
  const ledger = (await qa.pool.query('SELECT count(*)::int AS n FROM stock_movements')).rows[0].n;
  const gates = (await qa.pool.query('SELECT count(*)::int AS n FROM gate_events')).rows[0].n;
  const results = (await Promise.all([finish(order), finish(order)])).map(response => check(response, 200));
  assert.equal(results[0].status, 'SELESAI_PACKING');
  assert.equal(results[0].order.status, 'SIAP_PACKING');
  assert.equal(results[0].order.packing_status, 'SELESAI_PACKING');
  assert.equal(results[0].completed_by, qa.actor.id);
  assert.ok(results[0].completed_at);
  assert.deepEqual(results[0], results[1]);
  assert.deepEqual((await events(order)).map(event => event.action), ['CHECKLIST_SAVED', 'PACKING_COMPLETED']);
  check(await save(order, 2), 409);
  const { rows: [stock] } = await qa.pool.query(`SELECT t.status AS tag_status, i.status AS item_status, s.released_at
    FROM picking_scans s JOIN tags t ON t.id=s.tag_id JOIN items i ON i.id=s.item_id WHERE s.order_id=$1`, [order]);
  assert.deepEqual(stock, { tag_status: 'RESERVED', item_status: 'RESERVED', released_at: null });
  assert.equal((await qa.pool.query('SELECT count(*)::int AS n FROM stock_movements')).rows[0].n, ledger);
  assert.equal((await qa.pool.query('SELECT count(*)::int AS n FROM gate_events')).rows[0].n, gates);
});

test('SQL error on audit insertion rolls back finalization and keeps prior revision', async () => {
  const f = await picked('ROLLBACK-PACK');
  check(await save(f.order.id), 200);
  await qa.pool.query(`CREATE FUNCTION qa_reject_packing_completion() RETURNS trigger LANGUAGE plpgsql AS
    $$ BEGIN RAISE EXCEPTION 'synthetic packing audit failure'; END $$;
    CREATE TRIGGER qa_reject_packing_completion BEFORE INSERT ON picking_packing_events
      FOR EACH ROW WHEN (NEW.action = 'PACKING_COMPLETED') EXECUTE FUNCTION qa_reject_packing_completion()`);
  try {
    check(await finish(f.order.id), 500);
    const read = check(await view(f.order.id), 200);
    assert.equal(read.status, 'MENUNGGU_PACKING');
    assert.equal(read.revision, 1);
    assert.equal(read.completed_at, null);
    assert.equal((await events(f.order.id)).length, 1);
  } finally {
    await qa.pool.query('DROP TRIGGER qa_reject_packing_completion ON picking_packing_events; DROP FUNCTION qa_reject_packing_completion()');
  }
  check(await finish(f.order.id), 200);
});

test('Packing validates UUID, revision, Boolean checklist, signed JWT and warehouse role', async () => {
  const f = await picked('AUTH-PACK');
  check(await view('invalid'), 400);
  check(await view(randomUUID()), 404);
  check(await qa.api.inject({ url: url(f.order.id, 'packing') }), 401);
  check(await save(f.order.id, 0, all, 'VIEWER'), 403);
  check(await save(f.order.id, -1), 400);
  check(await save(f.order.id, 0, { ...all, label_checked: 'yes' as unknown as boolean }), 400);
  assert.deepEqual(await events(f.order.id), []);
});
