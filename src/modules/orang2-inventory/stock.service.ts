import { db } from '../../config/db';

/**
 * Stock Calculation Service
 *
 * Menghitung saldo stok berdasarkan agregasi
 * seluruh mutasi pada tabel stock_movements.
 *
 * Tidak melakukan UPDATE products.current_stock.
 */
export async function getAggregatedStockByProduct() {
  const result = await db.query(`
    SELECT
      p.id AS product_id,
      p.sku,
      p.name AS product_name,
      p.category,
      p.min_stock_threshold,
      COALESCE(SUM(sm.qty_change), 0)::INT AS current_stock,
      COUNT(sm.id)::INT AS total_transactions
    FROM products p
    LEFT JOIN stock_movements sm
      ON (
        sm.product_id = p.id
        OR (
          sm.product_id IS NULL
          AND sm.sku = p.sku
        )
      )
    GROUP BY
      p.id,
      p.sku,
      p.name,
      p.category,
      p.min_stock_threshold
    ORDER BY p.sku ASC
  `);

  return result.rows.map((row) => ({
    ...row,
    current_stock: Number(row.current_stock),
    total_transactions: Number(row.total_transactions),
    stock_status:
      Number(row.current_stock) <= Number(row.min_stock_threshold)
        ? 'STOK_RENDAH'
        : 'AMAN',
  }));
}

/**
 * Menghitung stok aktual berdasarkan lokasi rak.
 *
 * Setiap item berstatus IN_STOCK yang berada di lokasi
 * bertipe RACK dihitung sebagai satu unit stok.
 *
 * Tidak melakukan UPDATE products.current_stock.
 */
export async function getStockByRack() {
  const result = await db.query(`
    SELECT
      l.id AS location_id,
      l.code AS rack_code,
      l.name AS rack_name,
      p.id AS product_id,
      p.sku,
      p.name AS product_name,
      p.category,
      COUNT(i.id)::INT AS quantity
    FROM items i
    INNER JOIN products p
      ON p.id = i.product_id
    INNER JOIN locations l
      ON l.id = i.location_id
    WHERE
      i.status = 'IN_STOCK'
      AND l.location_type = 'RACK'
    GROUP BY
      l.id,
      l.code,
      l.name,
      p.id,
      p.sku,
      p.name,
      p.category
    ORDER BY
      l.code ASC,
      p.sku ASC
  `);

  return result.rows.map((row) => ({
    ...row,
    quantity: Number(row.quantity),
  }));
}
