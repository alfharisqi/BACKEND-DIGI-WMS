import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, realpath } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from 'jsonwebtoken';
import { Pool } from 'pg';
import { PickingRepository } from '../../src/modules/orang1-picking/repository';
import { PackingRepository } from '../../src/modules/orang1-picking/packing';
import { orang1PickingRoutes } from '../../src/modules/orang1-picking/routes';
import { orang1InboundRoutes } from '../../src/modules/orang1-inbound/routes';
import { PostgresRepository } from '../../src/modules/orang1-inbound/repository';
import { checkDatabaseConnection, db } from '../../src/config/db';
import { orang2InventoryRoutes } from '../../src/modules/orang2-inventory/routes';
import { qaScenario } from './scenario';

export const qaPort = 5102;
const pgBin = process.env.ORANG1_PICKING_PG_BIN ?? 'C:/Program Files/PostgreSQL/16/bin';

function pgCommand(command: string, args: string[]) {
  const result = spawnSync(path.join(pgBin, command + (process.platform === 'win32' ? '.exe' : '')), args, {
    encoding: 'utf8', windowsHide: true, timeout: 90_000,
  });
  if (result.status !== 0) throw new Error(`${command} QA: ${result.error?.message || result.stderr || result.stdout}`);
}

async function unusedPort(port = 0) {
  const socket = createServer();
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.listen(port, '127.0.0.1', resolve);
  });
  const address = socket.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
  return address.port;
}

export async function startPickingQa({ http = false, inbound = false } = {}) {
  if (http) await unusedPort(qaPort);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'digiwms-picking-qa-'));
  const port = await unusedPort();
  const api = Fastify();
  const pool = new Pool({ connectionString: `postgresql://postgres@127.0.0.1:${port}/postgres`, max: 8, connectionTimeoutMillis: 3500 });
  const previousSecret = process.env.JWT_SECRET;
  const jwtSecret = randomBytes(32).toString('hex');
  const password = process.env.ORANG1_PICKING_QA_PASSWORD || randomBytes(24).toString('hex');
  const actor = { id: randomUUID(), username: 'picking.qa', full_name: 'Petugas Picking QA', role: 'WAREHOUSE_STAFF' };
  let started = false;
  const originalQuery = db.query;
  const originalConnect = db.connect;

  async function close() {
    try {
      await api.close();
      await pool.end();
    } finally {
      if (inbound) { db.query = originalQuery; db.connect = originalConnect; }
      if (previousSecret === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = previousSecret;
      if (started) pgCommand('pg_ctl', ['-D', directory, '-m', 'fast', '-w', 'stop']);
    }
  }

  try {
    pgCommand('initdb', ['-D', directory, '-U', 'postgres', '-A', 'trust', '--no-locale', '--encoding=UTF8']);
    pgCommand('pg_ctl', ['-D', directory, '-l', path.join(directory, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${port}`, '-w', 'start']);
    started = true;
    const identity = (await pool.query("SELECT current_setting('data_directory') AS directory, host(inet_server_addr()) AS host")).rows[0];
    assert.equal(await realpath(identity.directory), await realpath(directory), 'Identitas cluster QA tidak cocok');
    assert.equal(identity.host, '127.0.0.1');
    process.env.JWT_SECRET = jwtSecret;

    const inventory = await readFile('tests/fixtures/supabase-orang1.sql', 'utf8');
    assert.ok(inventory.includes('capacity_status TEXT'));
    await pool.query(inventory);
    await pool.query(await readFile('sql/development/mvp1-compat.sql', 'utf8'));
    if (inbound) await pool.query(await readFile('sql/migrations/001_orang1_inbound_audit.sql', 'utf8'));
    await pool.query(await readFile('sql/migrations/002_orang1_picking.sql', 'utf8'));
    await pool.query(await readFile('sql/migrations/003_orang1_packing.sql', 'utf8'));
    await pool.query(`INSERT INTO public.users(id,username,email,password_hash,full_name,role)
      VALUES($1,$2,$3,'QA only',$4,$5)`, [actor.id, actor.username, 'inbound-qa@example.invalid', actor.full_name, actor.role]);
    if (inbound) {
      await pool.query(await readFile('sql/migrations/004_orang1_grn_lines.sql', 'utf8'));
      await api.register(orang1InboundRoutes, { repository: new PostgresRepository(pool), publish: () => {} });
      // Route the existing Putaway handler to the attested QA pool without editing Orang 2.
      db.query = pool.query.bind(pool);
      db.connect = pool.connect.bind(pool);
      assert.equal(await checkDatabaseConnection(), true);
      await api.register(orang2InventoryRoutes);
    }

    function token(role = actor.role, options: jwt.SignOptions = { expiresIn: '20m' }, id = actor.id) {
      return jwt.sign({ ...actor, id, role }, jwtSecret, options);
    }
    await api.register(cors, { origin: ['http://127.0.0.1:5178', 'http://localhost:5178'] });
    api.get('/api/health', async () => ({
      status: 'OK', qa: { kind: 'digiwms-picking-disposable-pg', isolated: true, mqtt: 'disabled' },
    }));
    if (http) {
      api.post('/api/auth/login', async (request, reply) => {
        const input = request.body as { username?: string; password?: string };
        if (input?.username !== actor.username || input?.password !== password) {
          return reply.code(401).send({ success: false, message: 'Sesi QA tidak valid.' });
        }
        return { success: true, data: { user: actor, token: token() } };
      });
      api.get('/api/dashboard/summary', async () => ({ success: true, data: null }));
      api.get('/api/products', async () => ({ success: true, data: [] }));
    }
    await api.register(orang1PickingRoutes, { repository: new PickingRepository(pool), packing: new PackingRepository(pool) });
    if (http) await api.listen({ host: '127.0.0.1', port: qaPort });
    else await api.ready();
    return { api, pool, actor, token, password, directory, version: (await pool.query('SHOW server_version')).rows[0].server_version, close };
  } catch (error) {
    await close();
    throw error;
  }
}

async function serve() {
  assert.ok(process.env.ORANG1_PICKING_QA_PASSWORD, 'Tentukan password khusus QA lewat ORANG1_PICKING_QA_PASSWORD.');
  const qa = await startPickingQa({ http: true });
  try {
    const sample = await qaScenario(qa.pool, 'MANUAL');
    const order = await sample.order('01');
    const wrong = await sample.item({ productId: sample.products.other });
    const first = await sample.item();
    const second = await sample.item({ locationId: sample.racks.alternate });
    const extra = await sample.item();
    console.log(JSON.stringify({ api: `http://127.0.0.1:${qaPort}/api`, username: qa.actor.username, order, sku: sample.sku, rack: sample.code, validEpcs: [first.epc, second.epc], extraEpc: extra.epc, wrongProductEpc: wrong.epc, missingOrderId: randomUUID() }, null, 2));
    await new Promise<void>(resolve => {
      process.once('SIGINT', resolve);
      process.once('SIGTERM', resolve);
    });
  } finally { await qa.close(); }
}

if (process.argv.includes('--serve')) serve().catch(error => { console.error(error.message); process.exitCode = 1; });
