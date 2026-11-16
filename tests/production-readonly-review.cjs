// Explicit opt-in, SELECT-only Production review. Never imports/runs a migration or CRUD write test.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { Client } = require('pg');
if (!process.argv.includes('--read-only')) { console.error('Use --read-only; no connection attempted.'); process.exit(1); }
require('dotenv').config();
const client = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 8000, query_timeout: 15000, application_name: 'orang1_final_readonly_review' });
async function main() {
  try {
    await client.connect();
    const securityResults = await client.query(await fs.readFile('sql/migrations/001_orang1_inbound_audit_verify.sql', 'utf8'));
    const securityRows = securityResults.flatMap(result => result.rows ?? []);
    const report = {
      captured_at: new Date().toISOString(), write_requests: 0, transaction_read_only: true,
      connection: securityRows.find(row => row.execution_role),
      permissions: securityRows.filter(row => row.rolname && Object.hasOwn(row, 'can_select')),
      audit_rls: securityRows.find(row => row.relname === 'orang1_inbound_audit'),
      audit_indexes: securityRows.filter(row => row.index_name),
    };
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    assert.equal((await client.query('SHOW transaction_read_only')).rows[0].transaction_read_only, 'on');
    report.uuid_columns = (await client.query("SELECT table_name,column_name,data_type FROM information_schema.columns WHERE table_schema='public' AND table_name IN ('products','goods_receipts','tags','items') AND (column_name='id' OR column_name IN ('product_id','tag_id','grn_id')) ORDER BY table_name,column_name")).rows;
    report.stock_comparison = (await client.query(`SELECT p.id,p.sku,p.current_stock,
      COALESCE((SELECT SUM(m.qty_change) FROM public.stock_movements m WHERE m.product_id=p.id),0)::int AS ledger_by_uuid,
      COALESCE((SELECT SUM(m.qty_change) FROM public.stock_movements m WHERE m.product_id IS NULL AND m.sku=p.sku),0)::int AS legacy_ledger_by_sku,
      (SELECT COUNT(*)::int FROM public.items i WHERE i.product_id=p.id) AS linked_items
      FROM public.products p ORDER BY p.sku`)).rows;
    report.tag_summary = (await client.query("SELECT tag_type,status,COUNT(*)::int AS total,COUNT(*) FILTER(WHERE epc !~ '^[0-9A-Fa-f]{24}$')::int AS legacy_epc FROM public.tags GROUP BY tag_type,status ORDER BY tag_type,status")).rows;
    report.grn_summary = (await client.query("SELECT g.id,g.po_number,to_char(g.receipt_date,'YYYY-MM-DD') AS receipt_date,g.total_qty,g.status,g.rfid_tagging_status,COUNT(i.id)::int AS linked_items FROM public.goods_receipts g LEFT JOIN public.items i ON i.grn_id=g.id GROUP BY g.id ORDER BY g.po_number")).rows;
    report.integrity = (await client.query(`SELECT
      (SELECT COUNT(*)::int FROM public.items i LEFT JOIN public.products p ON p.id=i.product_id WHERE p.id IS NULL) AS product_orphans,
      (SELECT COUNT(*)::int FROM public.items i LEFT JOIN public.tags t ON t.id=i.tag_id WHERE i.tag_id IS NOT NULL AND t.id IS NULL) AS tag_orphans,
      (SELECT COUNT(*)::int FROM public.items i LEFT JOIN public.goods_receipts g ON g.id=i.grn_id WHERE i.grn_id IS NOT NULL AND g.id IS NULL) AS grn_orphans,
      (SELECT COUNT(*)::int FROM public.tags t LEFT JOIN public.items i ON i.tag_id=t.id WHERE i.id IS NULL) AS tags_without_items,
      (SELECT COUNT(*)::int FROM public.orang1_inbound_audit) AS audit_count,
      (SELECT COUNT(*)::int FROM public.orang1_inbound_audit WHERE entity_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') AS non_uuid_audit_entity_ids`)).rows[0];
    report.fingerprints = {};
    for (const table of ['products', 'goods_receipts', 'tags', 'items', 'stock_movements', 'orang1_inbound_audit']) {
      report.fingerprints[table] = (await client.query(`SELECT COUNT(*)::int AS count, md5(COALESCE(string_agg(md5(to_jsonb(t)::text),'' ORDER BY id::text),'')) AS content_digest FROM public.${table} t`)).rows[0];
    }
    await client.query('ROLLBACK');
    const get = async path => {
      const response = await fetch(`http://localhost:5000/api${path}`, { method: 'GET', signal: AbortSignal.timeout(10000) });
      return { status: response.status, json: await response.json() };
    };
    report.api = [];
    const products = await get('/products'), grns = await get('/inbound/grn'), tags = await get('/tags');
    for (const [path, result] of [['/products', products], ['/inbound/grn', grns], ['/tags', tags]]) {
      assert.equal(result.status, 200); assert.equal(result.json.success, true);
      report.api.push({ path, status: result.status, count: result.json.data.length });
      for (const row of result.json.data) {
        const detail = await get(`${path}/${row.id}`); assert.equal(detail.status, 200); assert.equal(detail.json.data.id, row.id);
        report.api.push({ path: `${path}/:uuid`, status: detail.status });
      }
    }
    for (const row of report.stock_comparison) assert.equal(products.json.data.find(p => p.id === row.id).current_stock, row.current_stock);
    for (const row of report.grn_summary) assert.equal(grns.json.data.find(g => g.id === row.id).receipt_date, row.receipt_date);
    assert.ok(tags.json.data.every(tag => tag.type && typeof tag.epc === 'string'));
    const missing = await get('/products/00000000-0000-4000-8000-000000000000'); assert.equal(missing.status, 404);
    report.api.push({ path: '/products/:missing_uuid', status: missing.status });
    report.health = (await get('/health')).json;
    const label = process.argv.find(value => value.startsWith('--label='))?.slice(8) ?? 'final';
    assert.match(label, /^[a-z0-9-]+$/);
    await fs.mkdir('tests/evidence', { recursive: true });
    await fs.writeFile(`tests/evidence/production-readonly-${label}.json`, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ read_only: true, write_requests: 0, api_get_checks: report.api.length, cached_stock_matches_api: true,
      grn_calendar_dates_match_api: true, audit_count: report.integrity.audit_count, orphans: [report.integrity.product_orphans, report.integrity.tag_orphans, report.integrity.grn_orphans],
      evidence: `tests/evidence/production-readonly-${label}.json` }));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(JSON.stringify({ success: false, error_code: error.code ?? error.name, message: 'Read-only review failed; credentials/connection details withheld.' }));
    process.exitCode = 1;
  } finally { await client.end().catch(() => {}); }
}
main();
