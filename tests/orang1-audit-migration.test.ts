import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { PostgresRepository } from '../src/modules/orang1-inbound/repository';
import { InboundService } from '../src/modules/orang1-inbound/service';

let migration: string;
let verification: string;
const uuid = '18b635db-0ec3-41b1-a1ec-e15da1438ce2';
let admin: Pool;
const createdRoles: string[] = [];

describe('Supabase audit migration / disposable local PostgreSQL only', { skip: !process.env.ORANG1_TEST_DATABASE_URL }, () => {
  before(async () => {
    [migration, verification] = await Promise.all([
      readFile('sql/migrations/001_orang1_inbound_audit.sql', 'utf8'),
      readFile('sql/migrations/001_orang1_inbound_audit_verify.sql', 'utf8'),
    ]);
    assert.equal(process.env.ORANG1_TEST_ISOLATED, '1');
    const url = new URL(process.env.ORANG1_TEST_DATABASE_URL!);
    assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname), 'Remote databases are forbidden in this test');
    admin = new Pool({ connectionString: url.href });
    const { rows } = await admin.query('SHOW data_directory');
    assert.match(rows[0].data_directory.replaceAll('\\', '/'), /\/digiwms-audit-review-pg-[a-f0-9]{32}\/?$/, 'Use a dedicated audit review cluster, never an existing project database');
    for (const [role, bypass] of [['anon', false], ['authenticated', false], ['service_role', true], ['orang1_audit_qa_bypass', true], ['orang1_audit_qa_leak', false]] as const) {
      if (!(await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role])).rowCount) {
        await admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER ${bypass ? 'BYPASSRLS' : 'NOBYPASSRLS'}`);
        createdRoles.push(role);
      }
    }
  });
  after(async () => {
    if (!admin) return;
    for (const role of createdRoles.reverse()) await admin.query(`DROP ROLE ${role}`);
    await admin.end();
  });

  async function fixture(work: (pool: Pool) => Promise<void>, defaultGrants = true) {
    const database = `orang1_audit_test_${randomUUID().replaceAll('-', '')}`;
    assert.match(database, /^orang1_audit_test_[a-f0-9]{32}$/);
    await admin.query(`CREATE DATABASE ${database}`);
    const url = new URL(process.env.ORANG1_TEST_DATABASE_URL!); url.pathname = `/${database}`;
    const pool = new Pool({ connectionString: url.href, max: 3 });
    try {
      // Disposable stand-ins with native UUID PK/FK. No backup or production data is imported.
      await pool.query(`
        CREATE TABLE public.products (id UUID PRIMARY KEY, sku TEXT UNIQUE, name TEXT);
        CREATE TABLE public.goods_receipts (id UUID PRIMARY KEY, po_number TEXT UNIQUE, status TEXT);
        CREATE TABLE public.tags (id UUID PRIMARY KEY, epc TEXT UNIQUE, type TEXT, status TEXT);
        CREATE TABLE public.items (id UUID PRIMARY KEY, product_id UUID REFERENCES public.products(id), tag_id UUID REFERENCES public.tags(id), grn_id UUID REFERENCES public.goods_receipts(id), location_id UUID);
        CREATE TABLE public.stock_movements (id UUID PRIMARY KEY, product_id UUID REFERENCES public.products(id), item_id UUID REFERENCES public.items(id), reference_doc TEXT);
        CREATE TABLE public.gate_events (id UUID PRIMARY KEY, epc TEXT);
      `);
      await pool.query('INSERT INTO public.products VALUES ($1,$2,$3)', [uuid, 'QA-UUID', 'Disposable dummy product']);
      if (defaultGrants) await pool.query(`
        ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
        ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
      `);
      await work(pool);
    } finally {
      await pool.end();
      await admin.query(`DROP DATABASE ${database}`);
    }
  }
  async function apply(pool: Pool, sql = migration) {
    const client = await pool.connect();
    try { await client.query(sql); }
    catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async function asRole(pool: Pool, role: string, sql: string, values?: unknown[]) {
    assert.match(role, /^(anon|authenticated|service_role|orang1_audit_qa_bypass)$/);
    const client = await pool.connect();
    try { await client.query('BEGIN'); await client.query(`SET LOCAL ROLE ${role}`); return await client.query(sql, values); }
    finally { await client.query('ROLLBACK'); client.release(); }
  }
  async function snapshot(pool: Pool) {
    return {
      seed: (await pool.query('SELECT * FROM public.products ORDER BY id')).rows,
      constraints: (await pool.query("SELECT oid, conname, pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid IN ('public.products'::regclass, 'public.items'::regclass) ORDER BY oid")).rows,
      columns: (await pool.query("SELECT table_name,column_name,data_type FROM information_schema.columns WHERE table_schema='public' AND table_name IN ('products','goods_receipts','tags','items','stock_movements','gate_events') ORDER BY table_name,ordinal_position")).rows,
      defaults: (await pool.query('SELECT * FROM pg_default_acl ORDER BY oid')).rows,
    };
  }
  const assertDenied = (operation: Promise<unknown>) => assert.rejects(operation, (error: any) => error.code === '42501');

  test('Canonical SQL creates only audit relations and preserves UUID, FKs, seed and default privileges', () => fixture(async pool => {
    const before = await snapshot(pool);
    const oldRelations = (await pool.query("SELECT relname FROM pg_class WHERE relnamespace='public'::regnamespace")).rows.map(r => r.relname);
    await apply(pool);
    assert.deepEqual(await snapshot(pool), before);
    const added = (await pool.query("SELECT relname FROM pg_class WHERE relnamespace='public'::regnamespace ORDER BY relname")).rows.map(r => r.relname).filter(name => !oldRelations.includes(name));
    assert.deepEqual(added, ['orang1_inbound_audit', 'orang1_inbound_audit_entity_idx', 'orang1_inbound_audit_id_seq', 'orang1_inbound_audit_pkey']);
    const table = (await pool.query("SELECT relrowsecurity FROM pg_class WHERE oid='public.orang1_inbound_audit'::regclass")).rows[0];
    assert.equal(table.relrowsecurity, true);
    assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM pg_policies WHERE schemaname='public' AND tablename='orang1_inbound_audit'")).rows[0].count, 0);
    assert.equal((await pool.query("SELECT pg_get_serial_sequence('public.orang1_inbound_audit','id') AS sequence")).rows[0].sequence, 'public.orang1_inbound_audit_id_seq');
    const indexes = (await pool.query("SELECT indisvalid, indisready FROM pg_index WHERE indrelid='public.orang1_inbound_audit'::regclass")).rows;
    assert.equal(indexes.length, 2); assert.ok(indexes.every(i => i.indisvalid && i.indisready));
  }));

  test('No reliance on Supabase default grants: migration also works with no defaults', () => fixture(async pool => { await apply(pool); }, false));

  test('anon, authenticated and service_role cannot read/write/truncate table or use/reset sequence', () => fixture(async pool => {
    await apply(pool);
    for (const role of ['anon', 'authenticated', 'service_role']) {
      for (const sql of [
        'SELECT * FROM public.orang1_inbound_audit',
        `INSERT INTO public.orang1_inbound_audit (entity_type,entity_id,action,after_data) VALUES ('tag','qa','QA','{}')`,
        "UPDATE public.orang1_inbound_audit SET action='CHANGED'", 'DELETE FROM public.orang1_inbound_audit', 'TRUNCATE public.orang1_inbound_audit',
        "SELECT nextval('public.orang1_inbound_audit_id_seq')", "SELECT setval('public.orang1_inbound_audit_id_seq',99)",
      ]) await assertDenied(asRole(pool, role, sql));
    }
  }));

  test('RLS default deny still protects anon/authenticated if SELECT/INSERT are accidentally regranted', () => fixture(async pool => {
    await apply(pool);
    await pool.query('GRANT SELECT,INSERT ON public.orang1_inbound_audit TO anon,authenticated; GRANT USAGE ON public.orang1_inbound_audit_id_seq TO anon,authenticated');
    for (const role of ['anon', 'authenticated']) {
      assert.equal((await asRole(pool, role, 'SELECT * FROM public.orang1_inbound_audit')).rowCount, 0);
      await assertDenied(asRole(pool, role, "INSERT INTO public.orang1_inbound_audit (entity_type,entity_id,action,after_data) VALUES ('tag','qa','QA','{}')"));
    }
  }));

  test('Trusted non-owner BYPASSRLS role needs only SELECT/INSERT and sequence USAGE for repository audit', () => fixture(async pool => {
    await apply(pool);
    await pool.query('GRANT USAGE ON SCHEMA public TO orang1_audit_qa_bypass; GRANT SELECT,INSERT ON public.orang1_inbound_audit TO orang1_audit_qa_bypass; GRANT USAGE ON public.orang1_inbound_audit_id_seq TO orang1_audit_qa_bypass');
    const client = await pool.connect();
    try {
      await client.query('BEGIN'); await client.query('SET LOCAL ROLE orang1_audit_qa_bypass');
      const repository = new PostgresRepository(pool, client);
      await repository.audit('tag', uuid, 'ENCODE_SIMULATION', null, { product_id: uuid }, 'QA only', true);
      const history = await repository.history('tag', uuid);
      assert.equal(history.length, 1); assert.equal(history[0].entity_id, uuid);
      assert.equal(history[0].after_data.product_id, uuid); assert.equal(history[0].reason, 'QA only');
    } finally { await client.query('ROLLBACK'); client.release(); }
    await assertDenied(asRole(pool, 'orang1_audit_qa_bypass', "UPDATE public.orang1_inbound_audit SET action='BAD'"));
    await assertDenied(asRole(pool, 'orang1_audit_qa_bypass', "SELECT setval('public.orang1_inbound_audit_id_seq',99)"));
  }));

  test('Verified postgres backend can read/write; service UUID verification/cancellation/deactivation match audit schema', () => fixture(async pool => {
    await apply(pool);
    const repository = new PostgresRepository(pool), service = new InboundService(repository, () => {});
    assert.equal((await pool.query('SELECT current_user AS role')).rows[0].role, 'postgres');
    await pool.query('INSERT INTO public.goods_receipts VALUES ($1,$2,$3),($4,$5,$3)', [uuid, 'QA-VERIFY', 'MENUNGGU_VERIFIKASI', '28b635db-0ec3-41b1-a1ec-e15da1438ce2', 'QA-CANCEL']);
    await pool.query('INSERT INTO public.tags VALUES ($1,$2,$3,$4)', [uuid, '300833B2DDD9014000000001', 'STANDARD_LABEL', 'ENCODED']);
    await service.verifyGrn(uuid);
    await service.cancelGrn('28b635db-0ec3-41b1-a1ec-e15da1438ce2', { reason: 'Disposable QA cancellation' });
    await service.deactivateTag(uuid, { reason: 'Disposable QA damaged tag' });
    assert.equal((await repository.history('grn', uuid))[0].action, 'VERIFY');
    assert.equal((await repository.history('tag', uuid))[0].after_data.status, 'DAMAGED');
    assert.equal((await repository.history('grn', '28b635db-0ec3-41b1-a1ec-e15da1438ce2'))[0].reason, 'Disposable QA cancellation');
  }));

  test('Repository binds public and ignores search_path shadow audit tables', () => fixture(async pool => {
    await apply(pool);
    const client = await pool.connect();
    try {
      await client.query('CREATE SCHEMA shadow; CREATE TABLE shadow.orang1_inbound_audit (LIKE public.orang1_inbound_audit INCLUDING ALL)');
      await client.query('SET search_path=shadow,public');
      const repository = new PostgresRepository(pool, client);
      await repository.audit('product', uuid, 'CREATE', null, { id: uuid }, undefined, true);
      assert.equal((await repository.history('product', uuid)).length, 1);
      assert.equal((await client.query('SELECT COUNT(*)::int AS count FROM shadow.orang1_inbound_audit')).rows[0].count, 0);
    } finally { await client.query('RESET search_path'); client.release(); }
  }));

  test('Missing public audit cannot be masked by a shadow table; service rolls back status', () => fixture(async pool => {
    await pool.query('CREATE SCHEMA shadow; CREATE TABLE shadow.orang1_inbound_audit (id bigint)');
    await pool.query('INSERT INTO public.goods_receipts VALUES ($1,$2,$3)', [uuid, 'QA-NO-AUDIT', 'MENUNGGU_VERIFIKASI']);
    const client = await pool.connect();
    try {
      await client.query('SET search_path=shadow,public');
      await assert.rejects(new PostgresRepository(pool, client).audit('grn', uuid, 'VERIFY', {}, {}, undefined, true), (e: any) => e.status === 409);
    } finally { await client.query('RESET search_path'); client.release(); }
    await assert.rejects(new InboundService(new PostgresRepository(pool), () => {}).verifyGrn(uuid), (e: any) => e.status === 409);
    assert.equal((await pool.query('SELECT status FROM public.goods_receipts WHERE id=$1', [uuid])).rows[0].status, 'MENUNGGU_VERIFIKASI');
  }));

  test('Failure before COMMIT rolls back table, owned sequence, indexes and ACLs without altering source data', () => fixture(async pool => {
    const before = await snapshot(pool);
    const broken = migration.replace(/COMMIT;\s*$/, "DO $fault$ BEGIN RAISE EXCEPTION 'QA injected failure'; END $fault$; COMMIT;");
    await assert.rejects(apply(pool, broken), (e: any) => e.code === 'P0001');
    const state = (await pool.query("SELECT to_regclass('public.orang1_inbound_audit') AS table_name, to_regclass('public.orang1_inbound_audit_id_seq') AS sequence_name, to_regclass('public.orang1_inbound_audit_entity_idx') AS index_name")).rows[0];
    assert.deepEqual(state, { table_name: null, sequence_name: null, index_name: null });
    assert.deepEqual(await snapshot(pool), before);
  }));

  test('Repeated migration fails safely and preserves existing audit rows', () => fixture(async pool => {
    await apply(pool);
    const repository = new PostgresRepository(pool);
    await repository.audit('product', uuid, 'CREATE', null, { id: uuid }, undefined, true);
    await assert.rejects(apply(pool), (e: any) => e.code === '42P07');
    assert.equal((await repository.history('product', uuid)).length, 1);
  }));

  test('Pre-existing unrelated same-name table is never silently altered or reused', () => fixture(async pool => {
    await pool.query("CREATE TABLE public.orang1_inbound_audit (id UUID PRIMARY KEY, note TEXT); INSERT INTO public.orang1_inbound_audit VALUES ('18b635db-0ec3-41b1-a1ec-e15da1438ce2','Keep original')");
    await assert.rejects(apply(pool), (e: any) => e.code === '42P07');
    assert.equal((await pool.query('SELECT note FROM public.orang1_inbound_audit')).rows[0].note, 'Keep original');
    assert.equal((await pool.query("SELECT to_regclass('public.orang1_inbound_audit_id_seq') AS name")).rows[0].name, null);
  }));

  test('Pre-existing same-name sequence is preserved on migration failure', () => fixture(async pool => {
    await pool.query('CREATE SEQUENCE public.orang1_inbound_audit_id_seq START WITH 77');
    const before = (await pool.query('SELECT last_value,is_called FROM public.orang1_inbound_audit_id_seq')).rows;
    await assert.rejects(apply(pool), (e: any) => e.code === '42P07');
    assert.deepEqual((await pool.query('SELECT last_value,is_called FROM public.orang1_inbound_audit_id_seq')).rows, before);
    assert.equal((await pool.query("SELECT to_regclass('public.orang1_inbound_audit') AS name")).rows[0].name, null);
  }));

  test('Inherited client privileges abort deployment rather than changing unrelated role grants', () => fixture(async pool => {
    await pool.query('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO orang1_audit_qa_leak');
    await admin.query('GRANT orang1_audit_qa_leak TO anon');
    try {
      await assert.rejects(apply(pool), (e: any) => e.code === 'P0001' && /inherits SELECT/.test(e.message));
      assert.equal((await pool.query("SELECT to_regclass('public.orang1_inbound_audit') AS name")).rows[0].name, null);
    } finally { await admin.query('REVOKE orang1_audit_qa_leak FROM anon'); }
  }));

  test('Inherited sequence privilege also aborts the complete transaction', () => fixture(async pool => {
    await pool.query('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE ON SEQUENCES TO orang1_audit_qa_leak');
    await admin.query('GRANT orang1_audit_qa_leak TO authenticated');
    try {
      await assert.rejects(apply(pool), (e: any) => e.code === 'P0001' && /column\/sequence access/.test(e.message));
      assert.equal((await pool.query("SELECT to_regclass('public.orang1_inbound_audit_id_seq') AS name")).rows[0].name, null);
    } finally { await admin.query('REVOKE orang1_audit_qa_leak FROM authenticated'); }
  }));

  test('Verification SQL runs read-only before and after migration without reading payload rows', () => fixture(async pool => {
    for (const stage of ['before', 'after']) {
      if (stage === 'after') await apply(pool);
      const results = await pool.query(verification) as any;
      assert.ok(results.some((r: any) => r.rows?.some((row: any) => row.read_only === 'on')));
    }
  }));
});
