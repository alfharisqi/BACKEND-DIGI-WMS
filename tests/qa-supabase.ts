import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { PostgresRepository } from '../src/modules/orang1-inbound/repository';

export async function createSupabaseQa(expandedStatuses = false) {
  assert.equal(process.env.ORANG1_TEST_ISOLATED, '1', 'Explicit QA isolation required');
  assert.ok(process.env.ORANG1_TEST_DATABASE_URL, 'Separate QA URL is required; DATABASE_URL is never used');
  const url = new URL(process.env.ORANG1_TEST_DATABASE_URL!);
  assert.ok(['localhost', '127.0.0.1'].includes(url.hostname), 'Remote QA host forbidden');
  const admin = new Pool({ connectionString: url.href });
  const directory = (await admin.query('SHOW data_directory')).rows[0].data_directory.replaceAll('\\', '/');
  assert.match(directory, /\/digiwms-audit-review-pg-[a-f0-9]{32}\/?$/, 'Dedicated disposable cluster required');
  const schema = `orang1_supabase_qa_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: url.href, options: `-c search_path=${schema}`, max: 5 });
  const close = async () => {
    await pool.end(); assert.match(schema, /^orang1_supabase_qa_[a-f0-9]{32}$/);
    await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
  };
  try {
    await pool.query(await readFile('tests/fixtures/supabase-orang1.sql', 'utf8'));
    if (expandedStatuses) {
      // QA capability scenario only. These changes are NOT approved/executed on Production.
      await pool.query(`ALTER TABLE goods_receipts DROP CONSTRAINT qa_grn_status;
        ALTER TABLE goods_receipts ADD CONSTRAINT qa_grn_status CHECK(status IN ('MENUNGGU_VERIFIKASI','SELESAI','DIBATALKAN'));
        ALTER TABLE tags DROP CONSTRAINT qa_tag_status;
        ALTER TABLE tags ADD CONSTRAINT qa_tag_status CHECK(status IN ('UNASSIGNED','ENCODED','IN_STOCK','RESERVED','AUTHORIZED_OUT','EXITED','DAMAGED'));`);
    }
    const auditSql = (await readFile('sql/migrations/001_orang1_inbound_audit.sql', 'utf8')).replaceAll('public.', `${schema}.`).replaceAll("'public'", `'${schema}'`);
    await pool.query(auditSql);
    const product = (await pool.query("INSERT INTO products (sku,name,category,current_stock,unit_price) VALUES ('QA-SUPABASE-001','Produk QA Supabase','QA',15,650000) RETURNING *")).rows[0];
    const other = (await pool.query("INSERT INTO products (sku,name,category) VALUES ('QA-SUPABASE-002','Produk QA Kedua','QA') RETURNING *")).rows[0];
    return { pool, schema, product, other, repository: new PostgresRepository(pool, undefined, schema), close };
  } catch (error) { await close(); throw error; }
}
