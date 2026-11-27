
import { db } from '../../config/db';

/**
 * Menghitung stok berdasarkan agregasi seluruh mutasi ledger.
 * Tidak mengubah products.current_stock.
 */
export async function getAggregatedStockByProduct() {
  const result = await db.query(`
    WITH ledger_aggregate AS (
      SELECT
        p.id AS product_id,
        SUM(sm.qty_change)::INT AS current_stock,
        COUNT(sm.id)::INT AS total_transactions
      FROM stock_movements sm
      INNER JOIN products p
        ON (
          sm.product_id = p.id
          OR (
            sm.product_id IS NULL
            AND sm.sku = p.sku
          )
        )
      GROUP BY p.id
    )
    SELECT
      p.id AS product_id,
      p.sku,
      p.name AS product_name,
      p.category,
      p.min_stock_threshold,
      COALESCE(la.current_stock, 0)::INT AS current_stock,
      COALESCE(la.total_transactions, 0)::INT AS total_transactions
    FROM products p
    LEFT JOIN ledger_aggregate la
      ON la.product_id = p.id
    ORDER BY p.sku ASC
  `);

  return result.rows.map((row) => {
    const currentStock = Number(row.current_stock);
    const minStock = Number(row.min_stock_threshold ?? 0);

    return {
      ...row,
      current_stock: currentStock,
      total_transactions: Number(row.total_transactions),
      stock_status:
        currentStock <= minStock ? 'STOK_RENDAH' : 'AMAN',
    };
  });
}

/**
 * Menghitung stok fisik pada setiap rak.
 *
 * quantity                 = total barang fisik di rak.
 * available_quantity       = barang yang tersedia (IN_STOCK).
 * reserved_quantity        = barang yang sudah dialokasikan (RESERVED).
 * authorized_out_quantity  = barang yang sudah diotorisasi keluar.
 *
 * Barang tetap dihitung sebagai stok fisik selama masih
 * tercatat berada di lokasi dengan location_type = RACK.
 *
 * Satu item dihitung sebagai satu unit.
 */
export async function getStockByRack() {
  const result = await db.query(`
    WITH item_rack AS (
      SELECT
        l.id AS location_id,
        l.code AS rack_code,
        l.name AS rack_name,
        p.id AS product_id,
        p.sku,
        p.name AS product_name,
        p.category,
        COUNT(i.id)::INT AS quantity,
        COUNT(i.id) FILTER (WHERE i.status = 'IN_STOCK')::INT AS available_quantity,
        COUNT(i.id) FILTER (WHERE i.status = 'RESERVED')::INT AS reserved_quantity,
        COUNT(i.id) FILTER (WHERE i.status = 'AUTHORIZED_OUT')::INT AS authorized_out_quantity,
        COUNT(i.id)::INT AS unit_quantity,
        0::INT AS box_count,
        0::INT AS box_quantity
      FROM items i
      INNER JOIN products p ON p.id = i.product_id
      INNER JOIN locations l ON l.id = i.location_id
      WHERE l.location_type = 'RACK'
        AND i.status IN ('IN_STOCK', 'RESERVED', 'AUTHORIZED_OUT')
      GROUP BY l.id, l.code, l.name, p.id, p.sku, p.name, p.category
    ),
    box_rack AS (
      SELECT
        l.id AS location_id,
        l.code AS rack_code,
        l.name AS rack_name,
        p.id AS product_id,
        p.sku,
        p.name AS product_name,
        p.category,
        COALESCE(SUM(b.qty_per_box), 0)::INT AS quantity,
        COALESCE(SUM(b.qty_per_box), 0)::INT AS available_quantity,
        0::INT AS reserved_quantity,
        0::INT AS authorized_out_quantity,
        0::INT AS unit_quantity,
        COUNT(b.id)::INT AS box_count,
        COALESCE(SUM(b.qty_per_box), 0)::INT AS box_quantity
      FROM boxes b
      INNER JOIN products p ON p.id = b.product_id
      INNER JOIN locations l ON l.id = b.location_id
      WHERE l.location_type = 'RACK'
        AND b.status = 'IN_RACK'
      GROUP BY l.id, l.code, l.name, p.id, p.sku, p.name, p.category
    ),
    combined AS (
      SELECT * FROM item_rack
      UNION ALL
      SELECT * FROM box_rack
    )
    SELECT
      location_id,
      rack_code,
      rack_name,
      product_id,
      sku,
      product_name,
      category,
      SUM(quantity)::INT AS quantity,
      SUM(available_quantity)::INT AS available_quantity,
      SUM(reserved_quantity)::INT AS reserved_quantity,
      SUM(authorized_out_quantity)::INT AS authorized_out_quantity,
      SUM(unit_quantity)::INT AS unit_quantity,
      SUM(box_count)::INT AS box_count,
      SUM(box_quantity)::INT AS box_quantity
    FROM combined
    GROUP BY location_id, rack_code, rack_name, product_id, sku, product_name, category
    ORDER BY rack_code ASC, sku ASC
  `);

  return result.rows.map((row) => ({
    ...row,
    quantity: Number(row.quantity),
    available_quantity: Number(row.available_quantity),
    reserved_quantity: Number(row.reserved_quantity),
    authorized_out_quantity: Number(row.authorized_out_quantity),
    unit_quantity: Number(row.unit_quantity ?? 0),
    box_count: Number(row.box_count ?? 0),
    box_quantity: Number(row.box_quantity ?? 0),
  }));
}
