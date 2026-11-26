import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import Fastify from 'fastify';
import jwt from 'jsonwebtoken';
import type { Pool } from 'pg';
import { PackingRepository } from '../../src/modules/orang1-picking/packing';
import { PickingRepository } from '../../src/modules/orang1-picking/repository';
import { orang1PickingRoutes } from '../../src/modules/orang1-picking/routes';

const orderId = randomUUID();
const nextOrderId = randomUUID();
const actorId = randomUUID();
const orderNumber = 'ORDER-CANCELLATION-TEST';
const admin = { id: actorId, role: 'ADMIN' };
const reason = 'STOK_TIDAK_MENCUKUPI';
const releaseUnit = {
  scan_id: randomUUID(), tag_id: randomUUID(), item_id: randomUUID(), epc: 'A'.repeat(24),
  location_id: randomUUID(), location_code: 'A1', location_name: 'Rak A1',
};
const releasedAt = '2026-11-25T10:00:00.000Z';
const partialPayload = { reason, physical_return_confirmed: true, return_scan_ids: [releaseUnit.scan_id] };
const cancelUrl = `/api/picking/orders/${orderId}/cancel`;
const secret = 'picking-cancellation-test-secret';
const previousSecret = process.env.JWT_SECRET;
before(() => { process.env.JWT_SECRET = secret; });
after(() => {
  if (previousSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = previousSecret;
});

type Options = {
  approval?: boolean;
  schema?: boolean;
  status?: string;
  accountActive?: boolean;
  accountRole?: string;
  scan?: 'released' | 'active';
  packing?: boolean;
  handoff?: boolean;
  failAudit?: boolean;
  reservedBlocked?: boolean;
  blockAfterTagLock?: boolean;
  beforeAudit?: () => Promise<void>;
};

async function fixture(options: Options = {}) {
  let status = options.status ?? 'MENUNGGU_PICKING';
  let audit: Record<string, unknown> | undefined;
  let tail = Promise.resolve();
  const statements: string[] = [];
  const writes: string[] = [];
  let lockAttempts = 0;

  async function acquireOrder() {
    const prior = tail;
    let release!: () => void;
    tail = new Promise<void>(resolve => { release = resolve; });
    lockAttempts++;
    await prior;
    return release;
  }

  const result = (rows: unknown[] = [], rowCount = rows.length) => ({ rows, rowCount });
  function read(sql: string, values?: unknown[]) {
    statements.push(sql);
    if (/FROM public.users/.test(sql)) {
      assert.deepEqual(values, [actorId]);
      return result([{ role: options.accountRole ?? 'ADMIN', is_active: options.accountActive !== false, name: 'Petugas Uji' }]);
    }
    if (/WITH audit AS/.test(sql)) return result([{ ready: options.schema !== false }]);
    if (/WITH order_base AS/.test(sql)) {
      if (values?.[1] === nextOrderId) {
        assert.match(sql, /s\.released_at IS NULL/);
        assert.match(sql, /released_at IS NOT NULL/);
        assert.deepEqual(values, [null, nextOrderId, true]);
        return result([{ id: nextOrderId, status: 'MENUNGGU_PICKING',
          lines: [{ candidates: status === 'DIBATALKAN' ? [{ epc: releaseUnit.epc }] : [] }],
        }]);
      }
      if (values?.[0] && values[0] !== status) return result();
      return result([{ id: orderId, order_number: orderNumber, status, lines: [], picked_qty: 0 }]);
    }
    if (/FROM public.picking_cancellations WHERE/.test(sql)) {
      assert.deepEqual(values, [[orderId]]);
      return result(audit ? [audit] : []);
    }
    if (/WHERE o.id = ANY/.test(sql)) {
      assert.deepEqual(values, [[orderId]]);
      assert.match(sql, /NOT EXISTS \(SELECT 1 FROM public\.picking_scans s WHERE s\.order_id = o\.id\)/);
      for (const table of ['picking_packing', 'outbound_picking_orders', 'sales', 'gate_passes', 'stock_movements']) {
        assert.match(sql, new RegExp(`NOT EXISTS \\(SELECT 1 FROM public\\.${table} `));
      }
      const eligible = (status === 'MENUNGGU_PICKING' && !options.scan)
        || (status === 'SEDANG_DIAMBIL' && options.scan === 'active' && !options.reservedBlocked);
      return result(eligible && !options.packing && !options.handoff ? [{ id: orderId }] : []);
    }
    if (/FROM public.picking_packing p/.test(sql)) return result();
    if (/AS complete/.test(sql)) return result([{ complete: false }]);
    throw new Error(`Unexpected read: ${sql}`);
  }

  const pool = {
    query: read,
    connect: async () => {
      let releaseOrder: (() => void) | undefined;
      let pendingStatus: string | undefined;
      let pendingAudit: Record<string, unknown> | undefined;
      const pendingWrites: string[] = [];
      return {
        async query(sql: string, values?: unknown[]) {
          if (/^BEGIN|^SET LOCAL/.test(sql)) return result();
          if (sql === 'COMMIT' || sql === 'ROLLBACK') {
            statements.push(sql);
            if (sql === 'COMMIT') {
              if (pendingStatus) status = pendingStatus;
              if (pendingAudit) audit = pendingAudit;
              writes.push(...pendingWrites);
            }
            releaseOrder?.();
            releaseOrder = undefined;
            return result();
          }
          if (/FROM public.picking_orders WHERE id = \$1 FOR UPDATE/.test(sql)) {
            assert.deepEqual(values, [orderId]);
            releaseOrder = await acquireOrder();
            return result([{ status, order_number: orderNumber }]);
          }
          if (/UPDATE public.picking_orders SET status = 'DIBATALKAN'/.test(sql)) {
            assert.ok(releaseOrder);
            assert.deepEqual(values, [orderId, status]);
            assert.match(sql, /AND status = \$2/);
            pendingStatus = 'DIBATALKAN';
            pendingWrites.push('picking_orders');
            return result([], 1);
          }
          if (/FOR UPDATE OF t, i FOR SHARE OF l/.test(sql)) {
            assert.ok(releaseOrder);
            assert.deepEqual(values, [orderId]);
            statements.push('LOCK_EPCS');
            return result([{ id: releaseUnit.scan_id }]);
          }
          if (/ps.id AS scan_id/.test(sql)) {
            assert.equal(statements.at(-1), 'LOCK_EPCS');
            for (const evidence of ['outbound_picking_items', 'gate_events', 'stock_movements', 'GATE_PASS_AUTHORIZATION']) {
              assert.ok(sql.includes(evidence));
            }
            assert.match(sql, /i.location_id = ps.location_id/);
            return result([{ ...releaseUnit, eligible: !options.blockAfterTagLock }]);
          }
          if (/UPDATE public\.(tags|items|picking_scans)/.test(sql)) {
            const table = /UPDATE public\.(\w+)/.exec(sql)![1];
            const expected = table === 'tags' ? [[releaseUnit.tag_id]]
              : table === 'items' ? [[releaseUnit.item_id]] : [orderId, [releaseUnit.scan_id]];
            assert.deepEqual(values, expected);
            pendingWrites.push(table);
            return result(table === 'picking_scans' ? [{ id: releaseUnit.scan_id, released_at: releasedAt }] : [], 1);
          }
          if (/INSERT INTO public.picking_cancellations/.test(sql)) {
            assert.ok(releaseOrder);
            if (options.beforeAudit) await options.beforeAudit();
            if (options.failAudit) throw new Error('audit insert failed');
            assert.deepEqual(values?.slice(0, 3), [orderId, orderNumber, status]);
            assert.deepEqual(values?.slice(5, 7), [actorId, 'Petugas Uji']);
            pendingAudit = {
              order_id: orderId, order_number: orderNumber, previous_status: status,
              reason: values?.[3], notes: values?.[4], actor_id: actorId, actor_name: 'Petugas Uji',
              cancelled_at: releasedAt, physical_return_confirmed: values?.[7],
              released_units: JSON.parse(String(values?.[8])),
            };
            pendingWrites.push('picking_cancellations');
            return result([pendingAudit]);
          }
          return read(sql, values);
        },
        release() { assert.equal(releaseOrder, undefined, 'Transaction must release the lock before release()'); },
      };
    },
  } as unknown as Pool;

  const api = Fastify();
  await api.register(orang1PickingRoutes, {
    repository: new PickingRepository(pool, { cancellationApproved: options.approval }),
    packing: new PackingRepository(pool),
  });
  const auth = (role = 'ADMIN') => ({ authorization: `Bearer ${jwt.sign({ ...admin, role }, secret)}` });
  return {
    api, auth, writes, statements,
    get status() { return status; },
    get audit() { return audit; },
    get lockAttempts() { return lockAttempts; },
    acquireOrder,
    markScanCommitted() { status = 'SEDANG_DIAMBIL'; options.scan = 'active'; },
    cancel: (payload: unknown = { reason }, role = 'ADMIN') => api.inject({ method: 'POST', url: cancelUrl, headers: auth(role), payload: payload as object }),
    list: (filter?: string) => api.inject({ url: '/api/picking/orders' + (filter ? '?status=' + filter : ''), headers: auth(options.accountRole) }),
    nextCandidates: () => api.inject({ url: `/api/picking/orders/${nextOrderId}/available-epcs`, headers: auth() }),
    scan: () => api.inject({
      method: 'POST', url: '/api/picking/scan', headers: auth(), payload: { order_id: orderId, epc: 'A'.repeat(24) },
    }),
  };
}

test('CXL-A01, A16–A18: cancel an eligible order, preserve history, and write only order and audit', async t => {
  const f = await fixture({ approval: true });
  t.after(() => f.api.close());
  assert.equal((await f.list()).json().data[0].can_cancel, true);
  const response = await f.cancel({ reason, notes: '   Alasan terverifikasi  ', actor_id: randomUUID(), role: 'SUPERVISOR' });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().data.status, 'DIBATALKAN');
  assert.equal(f.audit?.notes, 'Alasan terverifikasi');
  assert.equal(f.audit?.actor_id, actorId);
  assert.deepEqual(f.writes, ['picking_orders', 'picking_cancellations']);
  const history = (await f.list('DIBATALKAN')).json().data[0];
  assert.equal(history.can_cancel, false);
  assert.deepEqual(history.cancellation, f.audit);
  const detail = await f.api.inject({ url: `/api/picking/orders/${orderId}/packing`, headers: f.auth() });
  assert.equal(detail.statusCode, 200);
  assert.deepEqual(detail.json().data.order.cancellation, f.audit);
});

for (const [id, options] of [
  ['A02', { status: 'SEDANG_DIAMBIL' }],
  ['A03', { status: 'SIAP_PACKING' }],
  ['A04', { status: 'DIKIRIM' }],
  ['A05', { status: 'DIBATALKAN' }],
  ['A06', { scan: 'released' }],
  ['A07', { scan: 'active' }],
  ['A08', { packing: true }],
  ['A09', { handoff: true }],
] as const) {
  test(`CXL-${id}: incompatible order or history is rejected`, async t => {
    const f = await fixture({ approval: true, ...options });
    t.after(() => f.api.close());
    assert.equal((await f.cancel()).statusCode, 409);
    assert.equal(f.lockAttempts, 1);
    assert.deepEqual(f.writes, []);
  });
}

test('CXL-A10–A12: reject unauthorized users and invalid cancellation payloads', async t => {
  const f = await fixture({ approval: true, accountRole: 'WAREHOUSE_STAFF' });
  t.after(() => f.api.close());
  assert.equal((await f.list()).json().data[0].can_cancel, false);
  assert.equal((await f.cancel({ reason }, 'WAREHOUSE_STAFF')).statusCode, 403);
  assert.equal((await f.cancel()).statusCode, 403);
  const unauthenticated = await f.api.inject({ method: 'POST', url: cancelUrl, payload: { reason } });
  assert.equal(unauthenticated.statusCode, 401);
  for (const invalid of [{ reason: '' }, { reason: 'LAINNYA', notes: '  ' }, { reason, notes: true }]) {
    assert.equal((await f.cancel(invalid)).statusCode, 400);
  }
  assert.equal(f.lockAttempts, 0);
  assert.deepEqual(f.writes, []);
  const inactive = await fixture({ approval: true, accountActive: false });
  t.after(() => inactive.api.close());
  assert.equal((await inactive.cancel()).statusCode, 403);
  assert.deepEqual(inactive.writes, []);
});

test('active non-admin warehouse roles keep Picking and Packing reads without cancellation rights', async t => {
  for (const role of ['SUPERVISOR', 'WAREHOUSE_STAFF', 'OPERATOR']) {
    const f = await fixture({ approval: true, accountRole: role });
    t.after(() => f.api.close());
    const orders = await f.list();
    assert.equal(orders.statusCode, 200, role);
    assert.equal(orders.json().data[0].can_cancel, false, role);

    for (const path of ['available-epcs', 'packing']) {
      const response = await f.api.inject({ url: `/api/picking/orders/${orderId}/${path}`, headers: f.auth(role) });
      assert.equal(response.statusCode, 200, `${role}: ${path}`);
    }
    assert.equal((await f.cancel({ reason, role: 'ADMIN', is_active: true }, role)).statusCode, 403, role);
    assert.equal(f.lockAttempts, 0, role);
    assert.deepEqual(f.writes, [], role);
  }
});

test('CXL-A13/A19: cancel wins the mocked order lock and the queued scan stops before any EPC change', async t => {
  let reachedAudit!: () => void;
  let unblockAudit!: () => void;
  const auditStarted = new Promise<void>(resolve => { reachedAudit = resolve; });
  const continueAudit = new Promise<void>(resolve => { unblockAudit = resolve; });
  const f = await fixture({
    approval: true,
    beforeAudit: () => { reachedAudit(); return continueAudit; },
  });
  t.after(() => f.api.close());
  const cancellation = f.cancel();
  await Promise.race([auditStarted, cancellation.then(() => assert.fail('Cancellation finished before writing audit'))]);
  const scan = f.scan();
  unblockAudit();
  const [cancelled, scanned] = await Promise.all([cancellation, scan]);
  assert.equal(cancelled.statusCode, 200);
  assert.equal(scanned.statusCode, 409);
  assert.equal(f.lockAttempts, 2);
  assert.deepEqual(f.writes, ['picking_orders', 'picking_cancellations']);
});

test('CXL-A13: when a scan commits first, cancellation reads the new state after the mocked lock', async t => {
  const f = await fixture({ approval: true });
  t.after(() => f.api.close());
  const unlock = await f.acquireOrder();
  const pendingCancel = f.cancel();
  try {
    for (let attempt = 0; f.lockAttempts === 1 && attempt < 100; attempt++) {
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.equal(f.lockAttempts, 2);
    f.markScanCommitted();
  } finally { unlock(); }
  assert.equal((await pendingCancel).statusCode, 400);
  assert.equal(f.status, 'SEDANG_DIAMBIL');
  assert.deepEqual(f.writes, []);
});

test('CXL-A14: concurrent confirmations commit exactly one audit in the mock', async t => {
  const f = await fixture({ approval: true });
  t.after(() => f.api.close());
  const answers = await Promise.all([f.cancel(), f.cancel()]);
  assert.deepEqual(answers.map(res => res.statusCode).sort(), [200, 409]);
  assert.deepEqual(f.writes, ['picking_orders', 'picking_cancellations']);
});

test('CXL-A15: failed audit rolls back the status change', async t => {
  const f = await fixture({ approval: true, failAudit: true });
  t.after(() => f.api.close());
  assert.equal((await f.cancel()).statusCode, 500);
  assert.equal(f.status, 'MENUNGGU_PICKING');
  assert.ok(f.statements.includes('ROLLBACK'));
  assert.deepEqual(f.writes, []);
});

test('Partial cancellation releases exact EPCs, records rack and scan history, and leaves ledger untouched', async t => {
  const f = await fixture({ approval: true, status: 'SEDANG_DIAMBIL', scan: 'active' });
  t.after(() => f.api.close());
  assert.equal((await f.list()).json().data[0].can_cancel, true);
  assert.deepEqual((await f.nextCandidates()).json().data.lines[0].candidates, []);
  assert.equal((await f.cancel()).statusCode, 400);
  assert.equal((await f.cancel({ ...partialPayload, return_scan_ids: [randomUUID()] })).statusCode, 409);
  assert.equal((await f.cancel({ ...partialPayload, return_scan_ids: [releaseUnit.scan_id, releaseUnit.scan_id] })).statusCode, 400);
  assert.deepEqual(f.writes, []);
  const response = await f.cancel(partialPayload);
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(f.writes, ['tags', 'items', 'picking_scans', 'picking_orders', 'picking_cancellations']);
  assert.equal(f.audit?.physical_return_confirmed, true);
  assert.deepEqual(f.audit?.released_units, [{ ...releaseUnit, released_at: releasedAt }]);
  assert.deepEqual((await f.nextCandidates()).json().data.lines[0].candidates, [{ epc: releaseUnit.epc }]);
  const refreshed = (await f.list('DIBATALKAN')).json().data[0];
  assert.deepEqual(refreshed.cancellation, f.audit);
  assert.equal(refreshed.can_cancel, false);
});

for (const [options, expected] of [
  [{ reservedBlocked: true }, 409], [{ blockAfterTagLock: true }, 409], [{ failAudit: true }, 500],
] as const) {
  test(`Partial cancellation rolls back on ${Object.keys(options)[0]}`, async t => {
    const f = await fixture({ approval: true, status: 'SEDANG_DIAMBIL', scan: 'active', ...options });
    t.after(() => f.api.close());
    const response = await f.cancel(partialPayload);
    assert.equal(response.statusCode, expected, response.body);
    assert.equal(f.status, 'SEDANG_DIAMBIL');
    assert.deepEqual(f.writes, []);
    assert.ok(f.statements.includes('ROLLBACK'));
  });
}

test('CXL-A20: neither Packing mutation can run after cancellation', async t => {
  const f = await fixture({ approval: true, status: 'DIBATALKAN' });
  t.after(() => f.api.close());
  for (const [method, suffix, payload] of [
    ['POST', 'packing-complete', { revision: 0 }],
    ['PATCH', 'packing-checklist', { revision: 0, checklist: {
      quantity_checked: false, epc_checked: false, condition_checked: false, packaging_checked: false, label_checked: false,
    } }],
  ] as const) {
    const response = await f.api.inject({
      method, url: `/api/picking/orders/${orderId}/${suffix}`, headers: f.auth(), payload,
    });
    assert.equal(response.statusCode, 409);
  }
  assert.deepEqual(f.writes, []);
});

test('CXL-A21: missing approval or migration disables the action while normal lists still load', async t => {
  for (const options of [{}, { approval: true, schema: false }]) {
    const f = await fixture(options);
    t.after(() => f.api.close());
    assert.equal((await f.list()).json().data[0].can_cancel, false);
    assert.deepEqual((await f.list('DIBATALKAN')).json().data, []);
    assert.equal((await f.cancel()).statusCode, 503);
    assert.equal(f.lockAttempts, 0);
    assert.deepEqual(f.writes, []);
  }
});
