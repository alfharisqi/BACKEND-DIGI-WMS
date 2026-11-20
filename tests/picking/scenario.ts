import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';

export async function qaScenario(pool: Pool, label: string, quantity = 2) {
  const serial = `${label}-${randomBytes(3).toString('hex').toUpperCase()}`;
  const sku = `QA-SKU-${serial}`;
  const productName = 'Kabel Picking QA';
  const getId = async (query: string, params: unknown[]) => (await pool.query<{ id: string }>(query, params)).rows[0].id;
  const products = {
    wanted: await getId("INSERT INTO products(sku,name,category,default_location_code,current_stock) VALUES($1,$2,'QA','DEFAULT-TIDAK-AKTUAL',9) RETURNING id", [sku, productName]),
    other: await getId("INSERT INTO products(sku,name,category) VALUES($1,'Produk Lain QA','QA') RETURNING id", [`QA-SKU-OTHER-${serial}`]),
  };
  const code = `QA-RACK-${serial}`;
  const racks = {
    main: await getId("INSERT INTO locations(code,zone_code,name,location_type) VALUES($1,'QA','Rak Fisik QA','RACK') RETURNING id", [code]),
    alternate: await getId("INSERT INTO locations(code,zone_code,name,location_type) VALUES($1,'QA','Rak Alternatif QA','RACK') RETURNING id", [`QA-ALT-${serial}`]),
    transit: await getId("INSERT INTO locations(code,zone_code,name,location_type) VALUES($1,'QA','Transit QA','TRANSIT') RETURNING id", [`QA-TRANSIT-${serial}`]),
  };

  async function item(options: { productId?: string; locationId?: string | null; tagStatus?: string; itemStatus?: string; epc?: string; link?: boolean } = {}) {
    const epc = options.epc ?? randomBytes(12).toString('hex').toUpperCase();
    const tagId = await getId('INSERT INTO tags(epc,status) VALUES($1,$2) RETURNING id', [epc, options.tagStatus ?? 'IN_STOCK']);
    const id = options.link === false ? null : await getId(`
      INSERT INTO items(tag_id,product_id,location_id,status) VALUES($1,$2,$3,$4) RETURNING id`,
    [tagId, options.productId ?? products.wanted, options.locationId === undefined ? racks.main : options.locationId, options.itemStatus ?? 'IN_STOCK']);
    return { epc, id, tagId };
  }

  async function order(name: string, lines: { productId: string; qty: number }[] = [{ productId: products.wanted, qty: quantity }]) {
    const number = `QA-ORD-${serial}-${name}`;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { id } = (await client.query<{ id: string }>('INSERT INTO picking_orders(order_number) VALUES($1) RETURNING id', [number])).rows[0];
      for (const line of lines) {
        await client.query('INSERT INTO picking_order_lines(order_id,product_id,requested_qty) VALUES($1,$2,$3)', [id, line.productId, line.qty]);
      }
      await client.query('COMMIT');
      return { id, number };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  return { code, sku, productName, products, racks, order, item };
}
