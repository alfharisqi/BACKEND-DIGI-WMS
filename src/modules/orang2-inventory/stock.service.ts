
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
    SELECT
      l.id AS location_id,
      l.code AS rack_code,
      l.name AS rack_name,
      p.id AS product_id,
      p.sku,
      p.name AS product_name,
      p.category,

      COUNT(i.id)::INT AS quantity,

      COUNT(i.id) FILTER (
        WHERE i.status = 'IN_STOCK'
      )::INT AS available_quantity,

      COUNT(i.id) FILTER (
        WHERE i.status = 'RESERVED'
      )::INT AS reserved_quantity,

      COUNT(i.id) FILTER (
        WHERE i.status = 'AUTHORIZED_OUT'
      )::INT AS authorized_out_quantity

    FROM items i
    INNER JOIN products p
      ON p.id = i.product_id
    INNER JOIN locations l
      ON l.id = i.location_id

    WHERE
      l.location_type = 'RACK'
      AND i.status IN (
        'IN_STOCK',
        'RESERVED',
        'AUTHORIZED_OUT'
      )

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
    available_quantity: Number(row.available_quantity),
    reserved_quantity: Number(row.reserved_quantity),
    authorized_out_quantity: Number(row.authorized_out_quantity),
  }));
}
