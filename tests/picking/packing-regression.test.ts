import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { packingFields } from '../../src/modules/orang1-picking/contract';
import { PackingRepository } from '../../src/modules/orang1-picking/packing';

const orderId = randomUUID();
const session = { id: randomUUID(), role: 'WAREHOUSE_STAFF' };
const orderNumber = 'PACKING-REGRESSION';
const tagId = randomUUID();
const itemId = randomUUID();
const checks = Object.fromEntries(packingFields.map(field => [field, true]));
type Step = [RegExp, unknown[]?, unknown[]?];

function fixture(steps: Step[], failGatePass = false) {
  let released = false;
  const pool = { connect: async () => ({
    query: async (sql: string, values?: unknown[]) => {
      const step = steps.shift();
      assert.ok(step, `Unexpected query: ${sql}`);
      const [pattern, rows = [], params] = step;
      assert.match(sql, pattern);
      if (params) assert.deepEqual(values, params);
      if (/INSERT INTO public.gate_passes/.test(sql)) {
        assert.match(String(values?.[0]), /^GP-PACK-\d{4}$/);
        assert.equal(values?.[1], orderNumber);
        assert.equal(values?.[2], session.id);
        if (failGatePass) throw new Error('Gate Pass insert failed');
      }
      return { rows, rowCount: rows.length };
    },
    release() { released = true; },
  }) } as unknown as Pool;
  return {
    packing: new PackingRepository(pool),
    assertComplete() { assert.equal(steps.length, 0); assert.ok(released); },
  };
}

const start = (): Step[] => [
  [/^BEGIN$/],
  [/^SET LOCAL lock_timeout/],
  [/public.users.+?FOR SHARE/s, [{ role: session.role, is_active: true, name: 'Fixture' }], [session.id]],
  [/public.picking_orders WHERE id = \$1 FOR UPDATE/, [{ id: orderId, status: 'SIAP_PACKING' }], [orderId]],
  [/FROM public.picking_packing p/, [{ ...checks, status: 'MENUNGGU_PACKING', revision: 1 }], [orderId]],
];

const finalizeUntilGate = (): Step[] => [
  ...start(),
  [/picking_order_lines.+FOR SHARE/, [], [orderId]],
  [/FOR SHARE OF s, i, t/, [], [orderId]],
  [/AND s.released_at IS NULL.+AUTHORIZED_OUT/s, [{ complete: true }], [orderId]],
  [/UPDATE public.picking_packing SET status='SELESAI_PACKING'/, [], [orderId, 2, session.id]],
  [/SELECT order_number FROM public.picking_orders/, [{ order_number: orderNumber }], [orderId]],
  [/FROM public.picking_scans.+released_at IS NULL/s, [{ item_id: itemId, tag_id: tagId, epc: 'A'.repeat(24) }], [orderId]],
  [/UPDATE public.tags.+AUTHORIZED_OUT.+status = 'RESERVED'/s, [], [[tagId]]],
  [/UPDATE public.items.+AUTHORIZED_OUT.+status = 'RESERVED'/s, [], [[itemId]]],
  [/SELECT id FROM public.gate_passes/, [], [orderNumber]],
  [/INSERT INTO public.gate_passes/],
];

test('Packing finalization commits authorized EPCs, Gate Pass, audit and the shipping read model', async () => {
  const { packing, assertComplete } = fixture([
    ...finalizeUntilGate(),
    [/INSERT INTO public.picking_packing_events/, [], [orderId, 2, 'PACKING_COMPLETED', session.id, 'Fixture', checks]],
    [/WITH order_base AS/, [{ id: orderId, status: 'DIKIRIM', shipping_stage: 'AUTHORIZED_OUT' }], [null, orderId, false]],
    [/FROM public.picking_packing p/, [{ ...checks, status: 'SELESAI_PACKING', revision: 2 }], [orderId]],
    [/AND s.released_at IS NULL.+AUTHORIZED_OUT/s, [{ complete: true }], [orderId]],
    [/^COMMIT$/],
  ]);
  const view = await packing.change(orderId, session, { action: 'PACKING_COMPLETED', revision: 1 });
  assert.equal(view.status, 'SELESAI_PACKING');
  assert.equal(view.order.shipping_stage, 'AUTHORIZED_OUT');
  assertComplete();
});

test('Packing rolls back the whole transaction when the Gate Pass insert fails', async () => {
  const { packing, assertComplete } = fixture([...finalizeUntilGate(), [/^ROLLBACK$/]], true);
  await assert.rejects(packing.change(orderId, session, { action: 'PACKING_COMPLETED', revision: 1 }), /Gate Pass insert failed/);
  assertComplete();
});
