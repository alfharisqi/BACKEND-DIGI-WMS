import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import Fastify from 'fastify';
import jwt from 'jsonwebtoken';
import type { Pool } from 'pg';
import { PickingRepository } from '../../src/modules/orang1-picking/repository';
import { orang1PickingRoutes } from '../../src/modules/orang1-picking/routes';

const actorId = randomUUID();
const productId = randomUUID();
const otherProduct = randomUUID();
const orderId = randomUUID();
const epc = 'E28011602000000000000101';
const actor = { role: 'WAREHOUSE_STAFF', is_active: true };
const product = { product_id: productId, sku: 'TEST-1', product_name: 'Monitor', available_qty: 2 };
const account = [/SELECT role, is_active/, [actor], [actorId]] as const;
const productStock = /WITH eligible_units AS/;
const orderView = /WITH order_base AS/;
const insertHeader = /INSERT INTO public\.picking_orders\b/;
const insertLines = /INSERT INTO public\.picking_order_lines\b/;
const order = { id: orderId, status: 'MENUNGGU_PICKING', lines: [] };
type Step = readonly [RegExp, unknown[]?, unknown[]?, Error?];

async function setup(expected: Step[]) {
  const queries = [...expected];
  const api = Fastify();
  let releases = 0;
  let connects = 0;
  const query = async (sql: string, values?: unknown[]) => {
    const step = queries.shift();
    assert.ok(step, `Unexpected SQL: ${sql}`);
    const [pattern, rows = [], params, failure] = step;
    assert.match(sql, pattern);
    if (params) assert.deepEqual(values, params);
    if (failure) throw failure;
    return { rows, rowCount: rows.length };
  };
  const pool = { query, connect: async () => {
    connects++;
    return { query, release: () => { releases++; } };
  } } as unknown as Pool;
  await api.register(orang1PickingRoutes, { repository: new PickingRepository(pool) });
  const headers = (role = actor.role) => ({
    authorization: `Bearer ${jwt.sign({ id: actorId, role }, process.env.JWT_SECRET!)}`,
  });
  const create = (lines: unknown, orderNumber: unknown = 'TEST-ORDER') => api.inject({
    method: 'POST', url: '/api/picking/orders', headers: headers(),
    payload: { order_number: orderNumber, lines },
  });
  return {
    api, headers, create,
    async close() {
      await api.close();
      assert.equal(queries.length, 0, 'Every expected SQL step should run');
      assert.equal(releases, connects, 'Each transaction must release its connection');
    },
  };
}

const savedSecret = process.env.JWT_SECRET;
before(() => { process.env.JWT_SECRET = 'picking-unit-test-secret'; });
after(() => {
  if (savedSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = savedSecret;
});

test('new reads require a warehouse JWT and a currently active account', async t => {
  const { api, headers, close } = await setup([[/SELECT role, is_active/, [{ ...actor, is_active: false }]]]);
  t.after(close);
  const url = `/api/picking/availability?product_id=${productId}`;
  assert.equal((await api.inject(url)).statusCode, 401);
  assert.equal((await api.inject({ url, headers: headers('KASIR_POS') })).statusCode, 403);
  assert.equal((await api.inject({ url, headers: headers() })).statusCode, 403);
  assert.equal((await api.inject({ url: `/api/picking/orders/${orderId}/available-epcs` })).statusCode, 401);
});

test('availability and candidates return Picking data with validated UUIDs', async t => {
  const lines = [
    { product_id: productId, requested_qty: 5, picked_qty: 0, available_qty: 2, remaining_qty: 5,
      shortage_qty: 3, candidates: [{ epc }] },
    { product_id: otherProduct, requested_qty: 1, picked_qty: 1, available_qty: 0,
      remaining_qty: 0, shortage_qty: 0, candidates: [] },
  ];
  const { api, headers, close } = await setup([
    account, [productStock, [product], [[productId]]],
    account, [productStock, [{ ...product, product_id: otherProduct, available_qty: 0 }], [[otherProduct]]],
    account, [orderView, [{ ...order, lines }], [null, orderId, true]],
    account, [orderView, [], [null, orderId, true]],
  ]);
  t.after(close);
  const request = (url: string) => api.inject({ url, headers: headers() });
  assert.equal((await request('/api/picking/availability?product_id=123')).statusCode, 400);
  assert.equal((await request('/api/picking/orders/123/available-epcs')).statusCode, 400);
  assert.deepEqual((await request(`/api/picking/availability?product_id=${productId}`)).json().data, product);
  assert.equal((await request(`/api/picking/availability?product_id=${otherProduct}`)).json().data.available_qty, 0);
  const url = `/api/picking/orders/${orderId}/available-epcs`;
  assert.deepEqual((await request(url)).json().data, { order_id: orderId, lines });
  assert.equal((await request(url)).statusCode, 404);
});

test('create rejects invalid numbers and IDs before starting a transaction', async t => {
  const { create, close } = await setup([]);
  t.after(close);
  for (const value of [undefined, null, 0, -1, 1.5, '2', 2147483648]) {
    assert.equal((await create([{ product_id: productId, requested_qty: value }])).statusCode, 400);
  }
  assert.equal((await create([{ product_id: '123', requested_qty: 1 }])).statusCode, 400);
  assert.equal((await create([], '   ')).statusCode, 400);
});

test('aggregate demand by UUID and reject shortages before any write', async t => {
  const { create, close } = await setup([
    [/^BEGIN$/], [/SET LOCAL/], account, [productStock, [product], [[productId]]], [/^ROLLBACK$/],
    [/^BEGIN$/], [/SET LOCAL/], account, [productStock, [], [[otherProduct]]], [/^ROLLBACK$/],
  ]);
  t.after(close);
  const response = await create([
    { product_id: productId.toUpperCase(), requested_qty: 2 },
    { product_id: productId, requested_qty: 1 },
  ]);
  assert.equal(response.statusCode, 409);
  assert.match(response.json().message, /Diminta 3 unit, tersedia 2 unit/);
  assert.equal((await create([{ product_id: otherProduct, requested_qty: 1 }])).statusCode, 404);
});

test('create at the available limit writes only order and lines, then commits', async t => {
  const { create, close } = await setup([
    [/^BEGIN$/], [/SET LOCAL/], account,
    [productStock, [product, { ...product, product_id: otherProduct }], [[productId, otherProduct]]],
    [insertHeader, [{ id: orderId }], ['TEST-ORDER']],
    [insertLines, [], [orderId, [productId, otherProduct], [2, 1]]],
    [orderView, [order], [null, orderId, false]], [/^COMMIT$/],
  ]);
  t.after(close);
  const response = await create([
    { product_id: productId, requested_qty: 1 },
    { product_id: productId, requested_qty: 1 },
    { product_id: otherProduct, requested_qty: 1 },
  ]);
  assert.equal(response.statusCode, 201);
  assert.deepEqual(response.json().data, order);
});

test('failed line insert rolls back the already inserted header', async t => {
  const { create, close } = await setup([
    [/^BEGIN$/], [/SET LOCAL/], account, [productStock, [product], [[productId]]],
    [insertHeader, [{ id: orderId }]], [insertLines, [], undefined, Object.assign(new Error('Foreign key'), { code: '23503' })],
    [/^ROLLBACK$/],
  ]);
  t.after(close);
  assert.equal((await create([{ product_id: productId, requested_qty: 2 }])).statusCode, 409);
});

test('per-EPC rejections are marked for continuation, database and order conflicts stop a batch', async t => {
  const readyOrder = [{ status: 'SIAP_PACKING' }];
  const waitingOrder = [{ status: 'MENUNGGU_PICKING' }];
  const { api, headers, close } = await setup([
    [/^BEGIN$/], [/SET LOCAL/], account, [/picking_orders.*FOR UPDATE/, waitingOrder],
    [/tags.*FOR UPDATE/, [], [epc]], [/^ROLLBACK$/],
    [/^BEGIN$/], [/SET LOCAL/], account, [/picking_orders.*FOR UPDATE/, readyOrder], [/^ROLLBACK$/],
    [/^BEGIN$/], [/SET LOCAL/], account, [/picking_orders.*FOR UPDATE/, waitingOrder],
    [/tags.*FOR UPDATE/, [], [epc], Object.assign(new Error('Deadlock'), { code: '40P01' })], [/^ROLLBACK$/],
  ]);
  t.after(close);
  const scan = () => api.inject({
    method: 'POST', url: '/api/picking/scan', headers: headers(), payload: { order_id: orderId, epc },
  });
  const rejected = await scan();
  assert.equal(rejected.statusCode, 404);
  assert.equal(rejected.json().code, 'PICKING_SCAN_REJECTED');
  for (const response of [await scan(), await scan()]) {
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().code, undefined);
  }
});
