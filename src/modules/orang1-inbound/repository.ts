import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { fail, Row, sameId } from './validation';

type Table = 'products' | 'goods_receipts' | 'tags' | 'items' | 'stock_movements' | 'gate_events' | 'locations';
export interface Repository {
  transaction<T>(work: (repo: Repository) => Promise<T>): Promise<T>;
  all(table: Table): Promise<Row[]>;
  get(table: Table, id: string): Promise<Row | undefined>;
  insert(table: Table, data: Row): Promise<Row>;
  update(table: Table, id: string, data: Row): Promise<Row>;
  removeProduct(id: string): Promise<void>;
  columns(table: Table): Promise<string[]>;
  allowedValues(table: Table, column: string): Promise<string[] | undefined>;
  audit(entity: string, entityId: unknown, action: string, before: Row | null, after: Row, reason?: string, required?: boolean): Promise<void>;
  history(entity: string, entityId: string): Promise<Row[]>;
}

// Keep the existing seed arrays by reference. Extra inbound state lives only in this process.
export class MemoryRepository implements Repository {
  private pending: Promise<unknown> = Promise.resolve();
  private source: Record<string, Row[]>;
  private sequences = new Map<string, number>();
  private uuidProducts: boolean;
  constructor(source: object) {
    this.source = source as Record<string, Row[]>;
    this.uuidProducts = this.source.products?.some(row => typeof row.id === 'string' && row.id.includes('-')) ?? false;
    for (const name of ['items', 'gate_events', 'orang1_inbound_audit']) this.source[name] ??= [];
  }
  async transaction<T>(work: (repo: Repository) => Promise<T>): Promise<T> {
    const run = this.pending.then(async () => {
      const snapshot = structuredClone(this.source);
      try { return await work(this); }
      catch (error) {
        // Main also stores shared configuration objects here. Inbound mutates table arrays only.
        for (const name of Object.keys(snapshot)) {
          if (Array.isArray(snapshot[name])) this.source[name].splice(0, this.source[name].length, ...snapshot[name]);
        }
        throw error;
      }
    });
    this.pending = run.catch(() => {});
    return run;
  }
  async all(table: Table) { return this.source[table] ?? []; }
  async get(table: Table, value: string) { return (await this.all(table)).find(row => sameId(row.id, value)); }
  async columns(table: Table) {
    const first = this.source[table]?.[0] ?? {};
    const known: Record<string, string[]> = {
      products: ['sku', 'name', 'category', 'unit_price' in first && !('price' in first) ? 'unit_price' : 'price', 'min_stock_threshold' in first && !('min_stock_alert' in first) ? 'min_stock_threshold' : 'min_stock_alert'],
      goods_receipts: ['po_number', 'supplier_name', 'receipt_date', 'total_qty', 'status', 'rfid_tagging_status'],
      tags: ['epc', 'status', 'tag_type' in first && !('type' in first) ? 'tag_type' : 'type'],
    };
    return [...new Set([...(known[table] ?? []), ...Object.keys(this.source[table]?.[0] ?? {})])];
  }
  async allowedValues(_table: Table, _column: string): Promise<string[] | undefined> { return undefined; }
  async insert(table: Table, data: Row) {
    const rows = this.source[table] ??= [];
    if (table === 'products') this.uuidProducts ||= rows.some(row => typeof row.id === 'string' && row.id.includes('-'));
    const uuidSource = table === 'products' && this.uuidProducts;
    const nextNumber = Math.max(this.sequences.get(table) ?? 0, ...rows.map(row => typeof row.id === 'number' ? row.id : typeof row.id === 'string' && /^\d+$/.test(row.id) && Number.isSafeInteger(Number(row.id)) ? Number(row.id) : 0)) + 1;
    this.sequences.set(table, nextNumber);
    const nextId = uuidSource ? randomUUID() : nextNumber;
    const row = { ...data, id: nextId, created_at: new Date().toISOString() };
    rows.push(row);
    if (table === 'items') this.syncTag(row);
    return row;
  }
  async update(table: Table, value: string, data: Row) {
    const row = await this.get(table, value);
    if (!row) return fail(404, 'Data tidak ditemukan.');
    Object.assign(row, data);
    if (table === 'tags' || table === 'items') row.updated_at = new Date().toISOString();
    if (table === 'items') this.syncTag(row);
    return row;
  }
  private syncTag(item: Row) {
    const tag = this.source.tags.find(row => sameId(row.id, item.tag_id));
    const product = this.source.products.find(row => sameId(row.id, item.product_id));
    if (tag && product) Object.assign(tag, { product_id: product.id, sku: product.sku, product_name: product.name });
  }
  async removeProduct(value: string) {
    const index = this.source.products.findIndex(row => sameId(row.id, value));
    this.source.products.splice(index, 1);
  }
  async audit(entity: string, entityId: unknown, action: string, before: Row | null, after: Row, reason?: string) {
    this.source.orang1_inbound_audit.push(structuredClone({ entity_type: entity, entity_id: String(entityId), action, before_data: before, after_data: after, reason: reason ?? null, created_at: new Date().toISOString() }));
  }
  async history(entity: string, entityId: string) {
    return this.source.orang1_inbound_audit.filter(row => row.entity_type === entity && sameId(row.entity_id, entityId));
  }
}

export class PostgresRepository implements Repository {
  // Production audit is always public-qualified. An explicit schema is reserved for isolated tests.
  constructor(private pool: Pool, private client?: PoolClient, private auditSchema = 'public') {
    if (!/^[a-z_][a-z0-9_]*$/.test(auditSchema)) throw new Error('Invalid audit schema.');
  }
  private auditRelation() { return `"${this.auditSchema}".orang1_inbound_audit`; }
  private projection(table: Table) {
    // PostgreSQL DATE is a calendar day. JSON text avoids pg's local-midnight Date -> UTC shift.
    return table === 'goods_receipts' ? "*, to_jsonb(goods_receipts)->>'receipt_date' AS receipt_date" : '*';
  }
  private query(sql: string, values?: unknown[]) { return (this.client ?? this.pool).query(sql, values); }
  async transaction<T>(work: (repo: Repository) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Short write critical section also blocks legacy putaway writers while checking history.
      // No ledger rows are changed. A timeout rolls back instead of waiting indefinitely.
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query('LOCK TABLE products, goods_receipts, tags, items, stock_movements, gate_events IN SHARE ROW EXCLUSIVE MODE');
      const result = await work(new PostgresRepository(this.pool, client, this.auditSchema));
      await client.query('COMMIT');
      return result;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async all(table: Table) { return (await this.query(`SELECT ${this.projection(table)} FROM ${table} ORDER BY id`)).rows; }
  async get(table: Table, value: string) {
    // Opaque ID comparison: never cast an external UUID into an integer FK.
    return (await this.query(`SELECT ${this.projection(table)} FROM ${table} WHERE id::text = $1`, [value])).rows[0];
  }
  async columns(table: Table) {
    return (await this.query('SELECT attname FROM pg_attribute WHERE attrelid = to_regclass($1) AND attnum > 0 AND NOT attisdropped', [table])).rows.map(row => row.attname as string);
  }
  async allowedValues(table: Table, column: string): Promise<string[] | undefined> {
    const enums = (await this.query(`SELECT e.enumlabel FROM pg_attribute a
      JOIN pg_enum e ON e.enumtypid=a.atttypid
      WHERE a.attrelid=to_regclass($1) AND a.attname=$2 ORDER BY e.enumsortorder`, [table, column])).rows.map(row => row.enumlabel as string);
    const checks = (await this.query(`SELECT pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c
      WHERE c.conrelid=to_regclass($1) AND c.contype='c'
      AND c.conkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid=to_regclass($1) AND attname=$2)]::smallint[]`, [table, column])).rows;
    const sets: string[][] = enums.length ? [enums] : [];
    for (const check of checks) {
      const array = /ANY\s*\(\s*ARRAY\[([\s\S]*?)\]/i.exec(check.definition);
      if (array) sets.push([...array[1].matchAll(/'((?:[^']|'')*)'/g)].map(match => match[1].replaceAll("''", "'")));
    }
    return sets.length ? sets.reduce((a, b) => a.filter(value => b.includes(value))) : undefined;
  }
  async insert(table: Table, data: Row) {
    const keys = Object.keys(data);
    // Keys come exclusively from the service's explicit field lists, never request keys.
    return (await this.query(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')}) RETURNING ${this.projection(table)}`, Object.values(data))).rows[0];
  }
  async update(table: Table, value: string, data: Row) {
    if ((table === 'tags' || table === 'items') && (await this.columns(table)).includes('updated_at')) data = { ...data, updated_at: new Date().toISOString() };
    const keys = Object.keys(data);
    return (await this.query(`UPDATE ${table} SET ${keys.map((key, i) => `${key}=$${i + 1}`).join(',')} WHERE id::text=$${keys.length + 1} RETURNING ${this.projection(table)}`, [...Object.values(data), value])).rows[0];
  }
  async removeProduct(value: string) { await this.query('DELETE FROM products WHERE id::text=$1', [value]); }
  private async hasAudit() { return Boolean((await this.query('SELECT to_regclass($1) AS name', [this.auditRelation()])).rows[0].name); }
  async audit(entity: string, entityId: unknown, action: string, before: Row | null, after: Row, reason?: string, required = false) {
    if (!(await this.hasAudit())) {
      if (required) fail(409, 'Penyimpanan audit Orang 1 belum tersedia. Terapkan migrasi additive 001_orang1_inbound_audit.sql secara manual sebelum tindakan ini.');
      return;
    }
    await this.query(`INSERT INTO ${this.auditRelation()} (entity_type, entity_id, action, before_data, after_data, reason) VALUES ($1,$2,$3,$4,$5,$6)`, [entity, String(entityId), action, before, after, reason ?? null]);
  }
  async history(entity: string, entityId: string) {
    if (!(await this.hasAudit())) return [];
    return (await this.query(`SELECT * FROM ${this.auditRelation()} WHERE entity_type=$1 AND entity_id=$2 ORDER BY id`, [entity, entityId])).rows;
  }
}
