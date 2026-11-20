const { randomBytes } = require('node:crypto');
const { Client } = require('pg');
const { readIdentity, dbOptions, verifyPidFile, verifyConnection, applyPickingMigrations } = require('./dev-db.cjs');

const scenarios = [
  [{ sku: 'DEV-MOUSE-PACK-01', name: 'Mouse Wireless Development', racks: ['DEV-A01'] }],
  [{ sku: 'DEV-KEYBOARD-01', name: 'Keyboard Mechanical Development', racks: ['DEV-A01', 'DEV-B01'] }],
  [
    { sku: 'DEV-MOUSEPAD-01', name: 'Mousepad Development', racks: ['DEV-B01', 'DEV-B01'] },
    { sku: 'DEV-USBHUB-01', name: 'USB Hub Development', racks: ['DEV-A01'] },
  ],
];
const wrong = { sku: 'DEV-PACK-WRONG-01', name: 'Barang Pembanding Packing Development', racks: ['DEV-A01'] };

async function addUnits(db, product, reference) {
  const { rows: [{ id: productId }] } = await db.query(`
    WITH inserted AS (
      INSERT INTO public.products(sku,name,category,unit_price,min_stock_threshold,current_stock)
      VALUES($1,$2,'Development',0,0,0) ON CONFLICT(sku) DO NOTHING RETURNING id
    ) SELECT id FROM inserted UNION ALL SELECT id FROM public.products WHERE sku=$1 LIMIT 1`, [product.sku, product.name]);
  for (const code of product.racks) {
    const { rows: [rack] } = await db.query(`
      SELECT id, code FROM public.locations WHERE code=$1 AND location_type='RACK' FOR UPDATE`, [code]);
    if (!rack) throw new Error(`Rak latihan ${code} tidak tersedia.`);
    const epc = 'D002' + randomBytes(10).toString('hex').toUpperCase();
    // Mirror the existing putaway outcome atomically. The rack capacity triggers remain active.
    await db.query(`
      WITH tag AS (
        INSERT INTO public.tags(epc,status) VALUES($1,'IN_STOCK') RETURNING id
      ), new_item AS (
        INSERT INTO public.items(tag_id,product_id,location_id,status,putaway_at)
        SELECT id,$2,$3,'IN_STOCK',now() FROM tag RETURNING tag_id
      )
      INSERT INTO public.stock_movements(tx_code, movement_type, product_id, sku, tag_id,
        from_location, to_location, qty_change, qty_label, reference_doc, performed_by_name, to_location_id)
      SELECT $4,'PUTAWAY',$2,$5,tag_id,'Meja Tagging Development',$6,1,'1 unit',$7,'Seed Packing Development',$3
      FROM new_item`, [epc, productId, rack.id, 'DEV-PACK-SEED-' + epc, product.sku, code, reference]);
  }
  // This column is the stored stock projection exposed by the existing SKU API.
  await db.query('UPDATE public.products SET current_stock=current_stock+$2, updated_at=now() WHERE id=$1',
    [productId, product.racks.length]);
  return productId;
}

async function movementUnits(db, reference, productId = null) {
  return (await db.query(`
    SELECT t.epc, l.code AS rack, i.status AS item_status, t.status AS tag_status
    FROM public.stock_movements m JOIN public.tags t ON t.id=m.tag_id
    JOIN public.items i ON i.tag_id=t.id JOIN public.locations l ON l.id=m.to_location_id
    WHERE m.reference_doc=$1 AND m.tx_code LIKE 'DEV-PACK-SEED-%' AND ($2::uuid IS NULL OR m.product_id=$2)
    ORDER BY l.code,t.epc`, [reference, productId])).rows;
}

async function seedPacking(db, batch) {
  await db.query('BEGIN');
  try {
    await db.query("SELECT pg_advisory_xact_lock(hashtext('digiwms:dev:packing-seed'))");
    const comparison = batch + '-WRONG';
    if (!(await movementUnits(db, comparison)).length) await addUnits(db, wrong, comparison);
    const [wrongUnit] = await movementUnits(db, comparison);
    const orders = [];
    for (const [index, products] of scenarios.entries()) {
      const number = `${batch}-0${index + 1}`;
      const inserted = await db.query(`
        INSERT INTO public.picking_orders(order_number) VALUES($1)
        ON CONFLICT(order_number) DO NOTHING RETURNING id`, [number]);
      if (inserted.rowCount) {
        const orderId = inserted.rows[0].id;
        for (const product of products) {
          const productId = await addUnits(db, product, number);
          await db.query('INSERT INTO public.picking_order_lines VALUES($1,$2,$3)', [orderId, productId, product.racks.length]);
        }
      }
      const { rows } = await db.query(`
        SELECT o.id AS order_id,o.status, p.id AS product_id,p.sku,p.name, line.requested_qty AS quantity
        FROM public.picking_orders o JOIN public.picking_order_lines line ON line.order_id=o.id
        JOIN public.products p ON p.id=line.product_id WHERE o.order_number=$1 ORDER BY p.sku`, [number]);
      if (!rows.length) throw new Error(`Order ${number} sudah ada tanpa baris latihan. Data existing dipertahankan.`);
      const lines = [];
      for (const row of rows) {
        lines.push({ sku: row.sku, product: row.name, quantity: row.quantity, units: await movementUnits(db, number, row.product_id) });
      }
      orders.push({ order_number: number, order_id: rows[0].order_id, status: rows[0].status, created: Boolean(inserted.rowCount), lines,
        wrong_product_epc: wrongUnit.epc });
    }
    await db.query('COMMIT');
    return orders;
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}

async function main() {
  const identity = readIdentity();
  verifyPidFile(identity);
  const db = new Client(dbOptions(identity));
  try {
    await db.connect();
    await verifyConnection(db, identity);
    await applyPickingMigrations(db, identity);
    const batch = process.argv.includes('--new-batch') ? 'DEV-PACK-' + randomBytes(6).toString('hex').toUpperCase() : 'DEV-PACK-MANUAL';
    console.log(JSON.stringify(await seedPacking(db, batch), null, 2));
  } finally { await db.end(); }
}

if (require.main === module) main().catch(error => {
  console.error('[Development] Seed Packing gagal:', error.message);
  process.exitCode = 1;
});
