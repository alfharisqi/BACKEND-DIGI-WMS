import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { checkDatabaseConnection, db } from '../src/config/db';
import { orang4DashboardRoutes } from '../src/modules/orang4-dashboard/routes';

const id = '06108017-dbb8-482d-9387-b48fcbcadb01';
const epc = 'A'.repeat(24);
const boxEpc = 'B'.repeat(24);
const otherEpc = 'C'.repeat(24);
const reference = 'POS-GATE-TEST';
const result = (rows: unknown[] = []) => ({ rows, rowCount: rows.length });

test('Gate Pass checks ownership under locks and commits POS, Box, and free stock with a durable EPC manifest', async t => {
  let scenario = 'blocked';
  let failManifest = false;
  let orderLockWait: Promise<void> | undefined;
  let notifyOrderLock: (() => void) | undefined;
  const statements: string[] = [];
  const manifests: Record<string, unknown>[] = [];
  t.mock.method(db, 'query', async (sql: string) => {
    if (sql.startsWith('SELECT NOW()')) return result([{ server_time: 'fixture' }]);
    if (sql.includes('ALTER TABLE public.boxes')) return result();
    assert.fail('Unexpected use of the pool outside the transaction.');
  });
  await checkDatabaseConnection();
  t.mock.method(db, 'connect', async () => ({
    release() { statements.push('release'); },
    async query(raw: string, args: unknown[] = []) {
      const sql = raw.trim();
      statements.push(sql);
      if (/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL)/.test(sql)) return result();
      if (/SELECT id, status FROM public.picking_orders/.test(sql)) {
        assert.match(sql, /FOR UPDATE/);
        notifyOrderLock?.();
        await orderLockWait;
        return scenario === 'cancelled' ? result([{ id, status: 'DIBATALKAN' }]) : result();
      }
      if (/SELECT id, invoice_or_resi/.test(sql)) {
        return scenario === 'pos' || scenario === 'badBox' || scenario === 'returned'
          ? result([{ id, invoice_or_resi: reference, order_type: 'POS', payment_status: 'PAID' }]) : result();
      }
      if (/SELECT ps.epc/.test(sql)) return result([{ epc }]);
      if (/FOR UPDATE OF t, i/.test(sql)) {
        assert.match(sql, /t.status = i.status AND t.status IN \('IN_STOCK', 'AUTHORIZED_OUT'\)/);
        return result([{
          epc, tag_id: id, item_id: id,
          tag_status: scenario.startsWith('reissue') ? 'AUTHORIZED_OUT' : args[1] ? 'IN_STOCK' : 'RESERVED',
          item_status: scenario.startsWith('reissue') ? 'AUTHORIZED_OUT' : 'IN_STOCK', in_rack: true,
        }]);
      }
      if (/AS box_id FROM public.boxes/.test(sql)) {
        return (args[0] as string[]).includes(boxEpc) ? result([{ epc: boxEpc, box_id: id }]) : result();
      }
      if (/AS picking_member/.test(sql)) {
        assert.ok(statements.some(query => /FOR UPDATE OF t, i/.test(query)));
        assert.match(sql, /ps.released_at IS NULL/);
        return result([{
          tag_id: id, picking_id: scenario === 'blocked' ? id : null,
          movement_type: args[1] ? 'POS_SALE' : null, movement_ref: args[1] ? reference : null,
          pos_returned: scenario === 'returned',
          same_manual_authorization: scenario === 'reissue',
        }]);
      }
      if (/m.qty_label = b.qty_per_box/.test(sql)) return scenario === 'badBox' ? result() : result([{ epc: boxEpc }]);
      if (/INSERT INTO public.gate_passes/.test(sql)) {
        return result([{ id, pass_code: args[1], sale_id: args[2], reference_resi: args[3] }]);
      }
      if (/^UPDATE public\.(tags|items|sales)/.test(sql)) return result();
      if (/INSERT INTO public.audit_logs/.test(sql)) {
        if (failManifest) throw new Error('fixture audit failure');
        assert.equal(args[0], id);
        manifests.push(JSON.parse(String(args[1])));
        return result();
      }
      if (/FROM public.gate_passes/.test(sql)) return result([{ id, pass_code: 'GP-TEST', status: 'ACTIVE',
        reference_resi: reference, valid_until: new Date(Date.now() + 86400000) }]);
      if (/SUM\(CASE WHEN sm.qty_change/.test(sql)) return result();
      if (/SELECT payload->'units' AS units/.test(sql)) return result([{ units: [{ epc, tag_id: id }], created_at: new Date() }]);
      if (/SELECT DISTINCT epc\s+FROM public.gate_events/.test(sql)) return result();
      if (/FOR UPDATE OF t$/.test(sql)) return result([{
        epc, tag_id: id, item_id: id, tag_status: 'AUTHORIZED_OUT', item_status: 'AUTHORIZED_OUT',
      }]);
      if (/FOR UPDATE OF b$/.test(sql)) return result();
      if (/SELECT 1 FROM public.audit_logs newer/.test(sql)) return result(scenario === 'newer-pass' ? [{}] : []);
      if (/^UPDATE public.gate_passes/.test(sql)) return result([{ id, status: 'USED', pass_code: 'GP-TEST' }]);
      if (/INSERT INTO public.gate_events/.test(sql)) {
        assert.equal(args[2], epc);
        assert.equal(args[7], id);
        return result();
      }
      assert.fail(`Unexpected SQL: ${sql}`);
    },
  }));

  const app = Fastify();
  t.after(() => app.close());
  await app.register(orang4DashboardRoutes);
  const generate = (reference_resi: string, epc_list: string[], sale_id?: string) => app.inject({
    method: 'POST', url: '/api/gate-passes/generate', payload: { reference_resi, epc_list, sale_id },
  });
  for (const [kind, ref, epcs, sale] of [
    ['blocked', 'MANUAL-TEST', [epc], undefined],
    ['cancelled', 'RESI-PICK-CANCELLED', [], undefined],
    ['returned', reference, [epc], id],
    ['badBox', reference, [epc, boxEpc], id],
  ] as const) {
    scenario = kind;
    statements.length = 0;
    assert.equal((await generate(ref, [...epcs], sale)).statusCode, 409, kind);
    assert.equal(statements.some(sql => /^INSERT|^UPDATE/.test(sql)), false);
    assert.deepEqual(statements.slice(-2), ['ROLLBACK', 'release']);
  }
  scenario = 'pos';
  statements.length = 0;
  const pos = await generate(reference, [], id);
  assert.equal(pos.statusCode, 201, pos.body);
  assert.deepEqual(manifests.at(-1), {
    reference, units: [{ epc, tag_id: id }, { epc: boxEpc, box_id: id }], tag_ids: [id],
  });
  assert.ok(statements.some(sql => /UPDATE public.items/.test(sql)));
  assert.deepEqual(statements.slice(-2), ['COMMIT', 'release']);

  scenario = 'free';
  assert.equal((await generate('MANUAL-TEST', [epc])).statusCode, 201);
  assert.equal(manifests.at(-1)?.reference, 'MANUAL-TEST');
  scenario = 'reissue-wrong-ref';
  assert.equal((await generate('UNRELATED-TEST', [epc])).statusCode, 409);
  scenario = 'reissue';
  assert.equal((await generate('MANUAL-TEST', [epc])).statusCode, 201);
  failManifest = true;
  assert.equal((await generate('MANUAL-TEST', [epc])).statusCode, 500);
  assert.deepEqual(statements.slice(-2), ['ROLLBACK', 'release']);
  failManifest = false;

  const wrongPass = await app.inject({ method: 'POST', url: '/api/gate-passes/GP-TEST/scan-out', payload: { scanned_epcs: [otherEpc] } });
  assert.equal(wrongPass.statusCode, 409, wrongPass.body);
  assert.match(wrongPass.json().message, /tidak tercantum/);
  assert.deepEqual(statements.slice(-2), ['ROLLBACK', 'release']);

  scenario = 'newer-pass';
  const superseded = await app.inject({ method: 'POST', url: '/api/gate-passes/GP-TEST/scan-out', payload: {} });
  assert.equal(superseded.statusCode, 409, superseded.body);
  assert.match(superseded.json().message, /Gate Pass yang terbaru/);
  scenario = 'pos';
  const scanOut = await app.inject({ method: 'POST', url: '/api/gate-passes/GP-TEST/scan-out', payload: {} });
  assert.equal(scanOut.statusCode, 200, scanOut.body);
  assert.equal(scanOut.json().data.status, 'USED');

  const blockedOnOrder = new Promise<void>(resolve => { notifyOrderLock = resolve; });
  let releaseOrderLock!: () => void;
  orderLockWait = new Promise<void>(resolve => { releaseOrderLock = resolve; });
  const pendingGate = generate('RESI-PICK-CANCELLED', [epc]);
  await blockedOnOrder;
  scenario = 'cancelled';
  releaseOrderLock();
  const lostRace = await pendingGate;
  assert.equal(lostRace.statusCode, 409);
  assert.match(lostRace.json().message, /sudah dibatalkan/);
});
