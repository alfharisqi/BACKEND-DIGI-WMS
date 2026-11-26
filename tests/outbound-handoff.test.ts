import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { test } from 'node:test';
import Fastify from 'fastify';
import { checkDatabaseConnection, db } from '../src/config/db';
import { generateToken } from '../src/middleware/auth';
import { outboundRoutes } from '../src/modules/orang2-inventory/outbound.routes';

const id = '06108017-dbb8-482d-9387-b48fcbcadb01';
const tagId = '06108017-dbb8-482d-9387-b48fcbcadb02';
const itemId = '06108017-dbb8-482d-9387-b48fcbcadb03';
const passId = '06108017-dbb8-482d-9387-b48fcbcadb04';
const shipmentId = '06108017-dbb8-482d-9387-b48fcbcadb05';
const payload = { invoice_or_resi: 'RESI-HANDOFF-MOCK', customer_or_destination: 'Tujuan', epcs: ['A'.repeat(24)] };
const picking = { type: 'PICKING_ORANG1', order_id: id };
const outbound = { type: 'OUTBOUND_PICKING', order_id: id };
const pos = { type: 'POS', sale_id: id };
const free = { type: 'STOK_BEBAS' };

test('Outbound validates each source and rejects stale handoffs without real database writes', async t => {
  let orderStatus = 'SIAP_PACKING';
  let activeSource = free.type;
  let wrongOwner = false;
  let handedOff = false;
  let failAudit = false;
  let useIssuedPass = true;
  let referencedOrder = false;
  let waitForLock = false;
  let preauthorized = false;
  let accountActive = true;
  const existingSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET ||= 'outbound-auth-fixture';
  t.after(() => {
    if (existingSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = existingSecret;
  });
  const lock = new EventEmitter();
  const calls: { sql: string; values: unknown[] }[] = [];
  const result = (rows: unknown[] = []) => ({ rows, rowCount: rows.length });
  const read = async (sql: string, values: unknown[] = []) => {
    calls.push({ sql, values });
    if (sql.startsWith('SELECT NOW()')) return result([{ server_time: 'fixture' }]);
    if (/WITH legacy_orders AS/.test(sql)) {
      assert.match(sql, /o\.status <> 'DIBATALKAN'/);
      assert.match(sql, /pack\.status = 'SELESAI_PACKING'/);
      assert.deepEqual(values, [true]);
      return result([{ id, source_type: 'PICKING_ORANG1', status: 'DIKIRIM' }]);
    }
    if (/WITH ledger_aggregate/.test(sql)) return result();
    if (/FROM public\.users WHERE id::text/.test(sql)) return result(accountActive ? [{}] : []);
    if (/array_agg\(t\.epc/.test(sql)) return result([{ id, invoice_or_resi: 'POS-MOCK', epcs: payload.epcs }]);
    assert.fail(`Unexpected pool query: ${sql}`);
  };
  t.mock.method(db, 'query', read);
  await checkDatabaseConnection();
  t.mock.method(db, 'connect', async () => ({
    release() {},
    async query(text: string, values: unknown[] = []) {
      const sql = text.trim();
      calls.push({ sql, values });
      if (/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL)/.test(sql)) return result();
      if (/^SELECT status FROM public\.(picking_orders|outbound_picking_orders)/.test(sql)) {
        assert.match(sql, /FOR UPDATE$/);
        if (waitForLock) {
          lock.emit('waiting');
          await once(lock, 'release');
        }
        return result([{ status: orderStatus }]);
      }
      if (/SELECT 1 FROM public\.picking_packing/.test(sql)) return result([{}]);
      if (/SELECT id, invoice_or_resi FROM public\.sales/.test(sql)) return result([{ id, invoice_or_resi: 'POS-MOCK' }]);
      if (/SELECT 1 FROM public\.picking_orders/.test(sql)) return result(referencedOrder ? [{}] : []);
      if (/FOR UPDATE OF t, i/.test(sql)) return result([{
        tag_id: tagId, item_id: itemId, epc: payload.epcs[0], location_type: 'RACK',
        tag_status: activeSource === pos.type ? 'AUTHORIZED_OUT' : activeSource === free.type && !preauthorized ? 'IN_STOCK' : 'AUTHORIZED_OUT',
        item_status: activeSource === pos.type || (activeSource === free.type && !preauthorized) ? 'IN_STOCK' : 'AUTHORIZED_OUT',
        product_id: id, location_id: id, sku: 'SKU-MOCK', product_name: 'Monitor',
      }]);
      if (/AS picking_owner/.test(sql)) {
        assert.match(sql, /ps\.released_at IS NULL/);
        assert.match(sql, /OUTBOUND_PREAUTHORIZED/);
        return result([{
          tag_id: tagId,
          picking_owner: activeSource === picking.type && !wrongOwner ? id : null,
          outbound_owner: activeSource === outbound.type ? id : null,
          latest_movement: activeSource === pos.type ? 'POS_SALE' : 'INBOUND',
          pos_eligible: activeSource === pos.type && !handedOff,
          already_handed_off: handedOff,
          preauthorized,
        }]);
      }
      if (/^SELECT tag_id, item_id, epc/.test(sql)) return result([{ tag_id: tagId, item_id: itemId, epc: payload.epcs[0] }]);
      if (/SELECT id\s+FROM locations/.test(sql)) return result([{}]);
      if (/INSERT INTO sales/.test(sql)) return result([{ id: shipmentId }]);
      if (/SELECT \* FROM public\.gate_passes/.test(sql)) return result(useIssuedPass ? [{ id: passId }] : []);
      if (/INSERT INTO public\.gate_passes/.test(sql)) return result([{ id: passId }]);
      if (/^UPDATE (items|tags)/.test(sql)) return result([{}]);
      if (/INSERT INTO stock_movements/.test(sql)) return result([{ qty_change: -1 }]);
      if (/OUTBOUND_PREAUTHORIZED.*outbound_authorization/s.test(sql)) return result([{ id: passId }]);
      if (/INSERT INTO public\.audit_logs/.test(sql)) {
        if (failAudit) throw new Error('audit failed');
        return result();
      }
      assert.fail(`Unexpected transaction query: ${sql}`);
    },
  }));

  const api = Fastify();
  t.after(() => api.close());
  await api.register(outboundRoutes);
  const ship = (source?: object) => api.inject({
    method: 'POST', url: '/api/outbound/shipments', payload: { ...payload, source },
  });
  const authorize = (source?: object) => api.inject({
    method: 'POST', url: '/api/outbound/authorize', payload: { epcs: payload.epcs, source },
  });
  const used = (pattern: RegExp) => calls.filter(call => pattern.test(call.sql));

  calls.length = 0;
  for (const response of [await ship(), await authorize()]) {
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().code, 'SHIPMENT_SOURCE_REQUIRED');
  }
  assert.equal(calls.length, 0);
  assert.equal((await authorize(picking)).statusCode, 409);
  assert.equal((await authorize(pos)).statusCode, 409);
  assert.equal((await api.inject('/api/outbound/pos-orders')).statusCode, 401);
  assert.equal((await api.inject({ url: '/api/outbound/pos-orders', headers: { authorization: 'Bearer jwt-digiwms-prototype' } })).statusCode, 401);
  const token = generateToken({ id, role: 'WAREHOUSE_STAFF', username: 'staff-fixture' });
  const posListing = () => api.inject({ url: '/api/outbound/pos-orders', headers: { authorization: `Bearer ${token}` } });
  assert.equal((await posListing()).json().data[0].invoice_or_resi, 'POS-MOCK');
  accountActive = false;
  assert.equal((await posListing()).statusCode, 403);
  const listing = await api.inject('/api/outbound/picking-orders?for_handoff=1');
  assert.equal(listing.statusCode, 200, listing.body);
  assert.equal(listing.json().data[0].status, 'DIKIRIM');

  for (const source of [picking, outbound, pos, free]) {
    calls.length = 0;
    activeSource = source.type;
    const response = await ship(source);
    assert.equal(response.statusCode, 201, response.body);
    const posHandoff = source.type === 'POS';
    assert.equal(response.json().data.total_qty_change, posHandoff ? 0 : -1);
    assert.equal(used(/INSERT INTO stock_movements/).length, posHandoff ? 0 : 1);
    assert.equal(used(/INSERT INTO public\.gate_passes/).length, posHandoff ? 0 : 1);
    const [audit] = used(/INSERT INTO public\.audit_logs.+OUTBOUND_HANDOFF/s);
    const manifests = used(/INSERT INTO public\.audit_logs.+GATE_PASS_AUTHORIZATION/s);
    assert.equal(manifests.length, posHandoff ? 0 : 1);
    if (!posHandoff) assert.deepEqual(JSON.parse(String(manifests[0].values[1])).tag_ids, [tagId]);
    const entry = JSON.parse(String(audit.values[1]));
    assert.equal(entry.source_type, source.type);
    assert.equal(entry.source_id, source.type === free.type ? null : id);
    assert.deepEqual(entry.tag_ids, [tagId]);
    assert.equal(used(/^COMMIT$/).length, 1);
    if (source.type !== free.type) assert.ok(calls[2].sql.includes('FOR UPDATE'));
  }

  activeSource = picking.type;
  calls.length = 0;
  waitForLock = true;
  const waiting = once(lock, 'waiting');
  const pending = ship(picking);
  await Promise.race([waiting, pending.then(() => assert.fail('Shipment completed before checking locked order'))]);
  orderStatus = 'DIBATALKAN';
  lock.emit('release');
  const stale = await pending;
  assert.equal(stale.statusCode, 409);
  assert.equal(used(/FOR UPDATE OF t, i|INSERT INTO/).length, 0);
  assert.equal(used(/^ROLLBACK$/).length, 1);
  waitForLock = false;
  orderStatus = 'SIAP_PACKING';

  calls.length = 0;
  referencedOrder = true;
  assert.equal((await ship(free)).statusCode, 409);
  assert.equal(used(/INSERT INTO/).length, 0);
  referencedOrder = false;

  calls.length = 0;
  wrongOwner = true;
  assert.equal((await ship(picking)).statusCode, 409);
  assert.equal(used(/INSERT INTO/).length, 0);
  wrongOwner = false;

  calls.length = 0;
  activeSource = pos.type;
  useIssuedPass = false;
  assert.equal((await ship(pos)).statusCode, 201);
  assert.deepEqual(used(/INSERT INTO public\.gate_passes/)[0].values.slice(1), [id, 'POS-MOCK']);
  assert.equal(used(/INSERT INTO stock_movements/).length, 0);
  calls.length = 0;
  handedOff = true;
  assert.equal((await ship(pos)).statusCode, 409);
  assert.equal(used(/INSERT INTO/).length, 0);
  handedOff = false;

  calls.length = 0;
  activeSource = free.type;
  const preauthorization = await authorize(free);
  assert.equal(preauthorization.statusCode, 200, preauthorization.body);
  assert.equal(preauthorization.json().authorization_id, passId);
  preauthorized = true;
  calls.length = 0;
  assert.equal((await ship({ ...free, authorization_id: passId })).statusCode, 201);

  calls.length = 0;
  preauthorized = false;
  failAudit = true;
  assert.equal((await ship(free)).statusCode, 500);
  assert.equal(used(/^COMMIT$/).length, 0);
  assert.equal(used(/^ROLLBACK$/).length, 1);
});
