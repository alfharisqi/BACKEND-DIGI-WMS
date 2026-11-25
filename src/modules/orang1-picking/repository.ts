import { Pool, PoolClient } from 'pg';
import { PickingError, PickingStatus, ScanRejected, createOrderInput, pickingEpcPattern } from './contract';
import { requireWarehouseAccount, type WarehouseSession } from '../warehouse-session';

type Database = Pool | PoolClient;

// Both read models use the same stock rule. The scan transaction rechecks it under locks.
const eligibleUnits = (productFilter: string) => `
    SELECT i.id AS item_id, i.product_id, t.id AS tag_id, t.epc,
        t.status AS tag_status, i.status AS item_status,
        l.id AS location_id, l.code AS location_code, l.name AS location_name
    FROM public.items i
    JOIN public.tags t ON t.id = i.tag_id
    JOIN public.locations l ON l.id = i.location_id
    WHERE i.status = 'IN_STOCK' AND t.status = 'IN_STOCK' AND l.location_type = 'RACK'
        AND t.epc ~ '${pickingEpcPattern.source}'
        AND ${productFilter}
        AND NOT EXISTS (
            SELECT 1 FROM public.picking_scans s
            WHERE (s.item_id = i.id OR s.tag_id = t.id) AND s.released_at IS NULL
        )`;

const productStock = `
WITH eligible_units AS (${eligibleUnits('i.product_id = ANY($1::uuid[])')}),
stock AS (
    SELECT product_id, count(*)::int AS available_qty FROM eligible_units GROUP BY product_id
)
SELECT p.id AS product_id, p.sku, p.name AS product_name, coalesce(stock.available_qty, 0) AS available_qty
FROM public.products p LEFT JOIN stock ON stock.product_id = p.id
WHERE p.id = ANY($1::uuid[])`;

type ProductStock = { product_id: string; sku: string; product_name: string; available_qty: number };

const orderView = `
WITH order_base AS (
    SELECT o.id, o.order_number, o.created_at, o.updated_at,
        CASE
            WHEN o.status = 'SIAP_PACKING'
                AND EXISTS (
                    SELECT 1 FROM public.picking_scans ps
                    WHERE ps.order_id = o.id AND ps.released_at IS NULL
                )
                AND NOT EXISTS (
                    SELECT 1 FROM public.picking_scans ps
                    JOIN public.items i ON i.id = ps.item_id
                    WHERE ps.order_id = o.id AND ps.released_at IS NULL
                      AND i.status NOT IN ('AUTHORIZED_OUT', 'EXITED')
                )
            THEN 'DIKIRIM'
            ELSE o.status
        END AS status,
        CASE
            WHEN EXISTS (
                SELECT 1 FROM public.picking_scans ps
                JOIN public.items i ON i.id = ps.item_id
                WHERE ps.order_id = o.id AND ps.released_at IS NULL AND i.status = 'EXITED'
            ) AND NOT EXISTS (
                SELECT 1 FROM public.picking_scans ps
                JOIN public.items i ON i.id = ps.item_id
                WHERE ps.order_id = o.id AND ps.released_at IS NULL AND i.status <> 'EXITED'
            ) THEN 'EXITED'
            WHEN EXISTS (
                SELECT 1 FROM public.picking_scans ps
                JOIN public.items i ON i.id = ps.item_id
                WHERE ps.order_id = o.id AND ps.released_at IS NULL AND i.status IN ('AUTHORIZED_OUT', 'EXITED')
            ) THEN 'AUTHORIZED_OUT'
            ELSE NULL
        END AS shipping_stage
    FROM public.picking_orders o
), selected_orders AS (
    SELECT id, order_number, status, shipping_stage, created_at, updated_at
    FROM order_base
    WHERE ($1::text IS NULL OR status = $1) AND ($2::uuid IS NULL OR id = $2)
), selected_lines AS (
    SELECT line.*
    FROM public.picking_order_lines line JOIN selected_orders o ON o.id = line.order_id
), scan_lists AS (
    SELECT s.order_id, s.product_id, (count(*) FILTER (WHERE s.released_at IS NULL))::int AS picked_qty,
        jsonb_agg(jsonb_build_object(
            'id', s.id, 'epc', s.epc, 'item_id', s.item_id, 'tag_id', s.tag_id,
            'location_id', s.location_id, 'location_code', s.location_code,
            'location_name', s.location_name, 'scanned_at', s.scanned_at,
            'scanned_by', s.scanned_by,
            'scanner_name', coalesce(to_jsonb(scanner)->>'full_name', to_jsonb(scanner)->>'username'),
            'active', s.released_at IS NULL
        ) ORDER BY s.scanned_at, s.id) AS scans
    FROM public.picking_scans s JOIN selected_orders o ON o.id = s.order_id
    LEFT JOIN public.users scanner ON scanner.id = s.scanned_by
    GROUP BY s.order_id, s.product_id
), line_progress AS (
    SELECT line.*, coalesce(s.picked_qty, 0) AS picked_qty, coalesce(s.scans, '[]'::jsonb) AS scans,
        greatest(line.requested_qty - coalesce(s.picked_qty, 0), 0) AS remaining_qty
    FROM selected_lines line
    LEFT JOIN scan_lists s ON s.order_id = line.order_id AND s.product_id = line.product_id
), eligible_units AS (
    ${eligibleUnits(`i.product_id IN (
        SELECT line.product_id FROM line_progress line JOIN selected_orders o ON o.id = line.order_id
        WHERE line.remaining_qty > 0 AND o.status IN ('MENUNGGU_PICKING', 'SEDANG_DIAMBIL')
    )`)}
), racks AS (
    SELECT product_id, location_id, location_code, location_name, count(*)::int AS available_qty
    FROM eligible_units GROUP BY product_id, location_id, location_code, location_name
), rack_exclusions AS (
    SELECT s.order_id, u.product_id, u.location_id, count(DISTINCT u.item_id)::int AS excluded_qty
    FROM public.picking_scans s
    JOIN selected_orders o ON o.id = s.order_id AND o.status IN ('MENUNGGU_PICKING', 'SEDANG_DIAMBIL')
    JOIN eligible_units u ON u.item_id = s.item_id OR u.tag_id = s.tag_id
    WHERE s.released_at IS NOT NULL
    GROUP BY s.order_id, u.product_id, u.location_id
), line_racks AS (
    SELECT line.order_id, rack.*, rack.available_qty - coalesce(x.excluded_qty, 0) AS line_available_qty
    FROM line_progress line
    JOIN selected_orders o ON o.id = line.order_id
    JOIN racks rack ON rack.product_id = line.product_id
    LEFT JOIN rack_exclusions x ON x.order_id = line.order_id
        AND x.product_id = rack.product_id AND x.location_id = rack.location_id
    WHERE line.remaining_qty > 0 AND o.status IN ('MENUNGGU_PICKING', 'SEDANG_DIAMBIL')
), rack_lists AS (
    SELECT order_id, product_id, sum(line_available_qty)::int AS available_qty,
        jsonb_agg(jsonb_build_object(
            'id', location_id, 'code', location_code, 'name', location_name, 'available_qty', line_available_qty
        ) ORDER BY location_code, location_id) AS locations
    FROM line_racks WHERE line_available_qty > 0 GROUP BY order_id, product_id
), candidate_lists AS (
    SELECT line.order_id, line.product_id, picks.candidates
    FROM line_progress line
    JOIN selected_orders o ON o.id = line.order_id
    CROSS JOIN LATERAL (
        SELECT jsonb_agg(to_jsonb(unit) ORDER BY unit.location_code, unit.epc) AS candidates
        FROM (
            SELECT u.epc, u.tag_status, u.item_status, u.location_code, u.location_name
            FROM eligible_units u
            WHERE u.product_id = line.product_id AND NOT EXISTS (
                SELECT 1 FROM public.picking_scans s
                WHERE s.order_id = line.order_id AND (s.item_id = u.item_id OR s.tag_id = u.tag_id)
            )
            ORDER BY u.location_code, u.epc LIMIT line.remaining_qty
        ) unit
    ) picks
    WHERE $3::boolean AND line.remaining_qty > 0 AND o.status IN ('MENUNGGU_PICKING', 'SEDANG_DIAMBIL')
)
SELECT o.id, o.order_number, o.status, o.shipping_stage, o.created_at, o.updated_at,
    coalesce(pack.status, 'MENUNGGU_PACKING') AS packing_status,
    sum(line.requested_qty)::float8 AS requested_qty,
    sum(line.picked_qty)::float8 AS picked_qty,
    jsonb_agg(jsonb_build_object(
        'product_id', p.id, 'sku', p.sku, 'product_name', p.name,
        'requested_qty', line.requested_qty, 'picked_qty', line.picked_qty, 'remaining_qty', line.remaining_qty,
        'available_qty', coalesce(r.available_qty, 0),
        'shortage_qty', CASE WHEN o.status IN ('MENUNGGU_PICKING', 'SEDANG_DIAMBIL')
            THEN greatest(line.remaining_qty - coalesce(r.available_qty, 0), 0) ELSE 0 END,
        'locations', coalesce(r.locations, '[]'::jsonb),
        'scans', line.scans
    ) || CASE WHEN $3::boolean THEN jsonb_build_object('candidates', coalesce(c.candidates, '[]'::jsonb))
        ELSE '{}'::jsonb END ORDER BY p.sku, p.id) AS lines
FROM selected_orders o
JOIN line_progress line ON line.order_id = o.id
JOIN public.products p ON p.id = line.product_id
LEFT JOIN rack_lists r ON r.order_id = line.order_id AND r.product_id = line.product_id
LEFT JOIN candidate_lists c ON c.order_id = line.order_id AND c.product_id = line.product_id
LEFT JOIN public.picking_packing pack ON pack.order_id = o.id
GROUP BY o.id, o.order_number, o.status, o.shipping_stage, o.created_at, o.updated_at, pack.status
ORDER BY o.created_at, o.id`;

export async function selectOrders(db: Database, status: PickingStatus | null, orderId: string | null, candidates = false) {
  return (await db.query(orderView, [status, orderId, candidates])).rows;
}

export async function verifyPickingAccount(db: Database, session: WarehouseSession, lock = false) {
  const { rows: [account] } = await db.query<{ role: string; is_active: boolean; name: string | null }>(`
    SELECT role, is_active, coalesce(full_name, username) AS name FROM public.users
    WHERE id = $1${lock ? ' FOR SHARE' : ''}`, [session.id]);
  return requireWarehouseAccount(session, account, (status, message) => { throw new PickingError(status, message); });
}

export class PickingRepository {
  constructor(private readonly pool: Pool) {}

  async orders(status: PickingStatus | null, session: WarehouseSession) {
    await verifyPickingAccount(this.pool, session);
    return selectOrders(this.pool, status, null);
  }

  async availability(productId: string, session: WarehouseSession) {
    await verifyPickingAccount(this.pool, session);
    const { rows: [product] } = await this.pool.query<ProductStock>(productStock, [[productId]]);
    if (!product) throw new PickingError(404, 'Produk tidak ditemukan.');
    return product;
  }

  async availableEpcs(orderId: string, session: WarehouseSession) {
    await verifyPickingAccount(this.pool, session);
    const [order] = await selectOrders(this.pool, null, orderId, true);
    if (!order) throw new PickingError(404, 'Pesanan picking tidak ditemukan.');
    return { order_id: order.id, lines: order.lines };
  }

  async create({ orderNumber, lines }: ReturnType<typeof createOrderInput>, session: WarehouseSession) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '5s'");
      await verifyPickingAccount(client, session, true);
      const { rows } = await client.query<ProductStock>(productStock, [lines.map(line => line.productId)]);
      const stock = new Map(rows.map(product => [product.product_id, product]));
      for (const { productId, quantity } of lines) {
        const product = stock.get(productId);
        if (!product) throw new PickingError(404, 'Produk pada pesanan tidak ditemukan.');
        if (quantity > product.available_qty) {
          throw new PickingError(409, `Stok ${product.product_name} tidak mencukupi. Diminta ${quantity} unit, tersedia ${product.available_qty} unit.`);
        }
      }
      const { rows: [{ id }] } = await client.query<{ id: string }>(
        `INSERT INTO public.picking_orders (order_number, status)
         VALUES ($1, 'MENUNGGU_PICKING') RETURNING id`, [orderNumber]);
      await client.query(`
        INSERT INTO public.picking_order_lines (order_id, product_id, requested_qty)
        SELECT $1::uuid, line.product_id, line.quantity
        FROM unnest($2::uuid[], $3::int[]) AS line(product_id, quantity)`,
      [id, lines.map(line => line.productId), lines.map(line => line.quantity)]);
      const [created] = await selectOrders(client, null, id);
      if (!created) throw new PickingError(500, 'Pesanan yang dibuat tidak dapat dibaca.');
      await client.query('COMMIT');
      return created;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async reserve(orderId: string, epc: string, session: WarehouseSession) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '5s'");
      // Keep the account eligible until the reservation commits.
      await verifyPickingAccount(client, session, true);
      // Serialize all scans for one order, including two different EPCs for the last unit.
      const order = (await client.query<{ status: PickingStatus }>(
        'SELECT status FROM public.picking_orders WHERE id = $1 FOR UPDATE', [orderId],
      )).rows[0];
      if (!order) throw new PickingError(404, 'Pesanan picking tidak ditemukan.');
      if (order.status !== 'MENUNGGU_PICKING' && order.status !== 'SEDANG_DIAMBIL') {
        throw new PickingError(409, order.status === 'SIAP_PACKING'
          ? 'Seluruh kuantitas pesanan sudah terpenuhi.' : 'Pesanan tidak dapat diproses untuk Picking.');
      }

      // Lock the same tag and item rows that downstream transactions must lock.
      const tag = (await client.query<{ id: string; status: string; epc: string }>(
        'SELECT id, status, epc FROM public.tags WHERE epc = $1 FOR UPDATE', [epc],
      )).rows[0];
      if (!tag) throw new ScanRejected(404, 'EPC tidak terdaftar.');
      const item = (await client.query<{ id: string; product_id: string; status: string; location_id: string | null }>(
        'SELECT id, product_id, status, location_id FROM public.items WHERE tag_id = $1 FOR UPDATE', [tag.id],
      )).rows[0];
      if (!item) throw new ScanRejected(409, 'EPC belum terhubung ke unit barang.');

      const duplicate = await client.query(`
        SELECT order_id FROM public.picking_scans
        WHERE (item_id = $1 OR tag_id = $2) AND (released_at IS NULL OR order_id = $3)
        ORDER BY (order_id = $3) DESC LIMIT 1`, [item.id, tag.id, orderId]);
      if (duplicate.rows[0]?.order_id === orderId) throw new ScanRejected(409, 'EPC ini sudah dipindai untuk pesanan ini.');
      if (duplicate.rowCount) throw new ScanRejected(409, 'Barang sudah direservasi untuk pesanan lain.');

      const line = (await client.query<{ requested_qty: number }>(
        'SELECT requested_qty FROM public.picking_order_lines WHERE order_id = $1 AND product_id = $2 FOR UPDATE',
        [orderId, item.product_id],
      )).rows[0];
      if (!line) throw new ScanRejected(409, 'Produk pada EPC tidak sesuai dengan pesanan.');
      if (tag.status !== 'IN_STOCK' || item.status !== 'IN_STOCK') {
        throw new ScanRejected(409, 'Tag dan item harus berstatus IN_STOCK agar dapat diambil.');
      }
      const rack = (await client.query<{ id: string; code: string; name: string }>(`
        SELECT id, code, name FROM public.locations
        WHERE id = $1 AND location_type = 'RACK' FOR SHARE`, [item.location_id])).rows[0];
      if (!rack) throw new ScanRejected(409, 'Unit belum berada di rak penyimpanan yang valid.');

      const picked = (await client.query<{ qty: number }>(`
        SELECT count(*)::int AS qty FROM public.picking_scans
        WHERE order_id = $1 AND product_id = $2 AND released_at IS NULL`,
      [orderId, item.product_id])).rows[0].qty;
      if (picked >= line.requested_qty) throw new ScanRejected(409, 'Kuantitas SKU ini sudah terpenuhi.');

      const updatedTag = await client.query(`
        UPDATE public.tags SET status = 'RESERVED', updated_at = now()
        WHERE id = $1 AND status = 'IN_STOCK'`, [tag.id]);
      const updatedItem = await client.query(`
        UPDATE public.items SET status = 'RESERVED', updated_at = now()
        WHERE id = $1 AND status = 'IN_STOCK'`, [item.id]);
      if (updatedTag.rowCount !== 1 || updatedItem.rowCount !== 1) {
        throw new ScanRejected(409, 'Ketersediaan unit berubah. Muat ulang pesanan dan coba lagi.');
      }
      const scan = (await client.query(`
        INSERT INTO public.picking_scans
            (order_id, product_id, item_id, tag_id, location_id, epc, location_code, location_name, scanned_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING id, order_id, product_id, item_id, tag_id, epc, location_id, location_code, location_name, scanned_at`,
      [orderId, item.product_id, item.id, tag.id, rack.id, tag.epc, rack.code, rack.name, session.id])).rows[0];
      await client.query(`
        UPDATE public.picking_orders o
        SET status = CASE WHEN EXISTS (
            SELECT 1 FROM public.picking_order_lines line
            WHERE line.order_id = o.id AND line.requested_qty > (
                SELECT count(*) FROM public.picking_scans s
                WHERE s.order_id = line.order_id AND s.product_id = line.product_id AND s.released_at IS NULL
            )
        ) THEN 'SEDANG_DIAMBIL' ELSE 'SIAP_PACKING' END, updated_at = now()
        WHERE o.id = $1`, [orderId]);
      const [updatedOrder] = await selectOrders(client, null, orderId);
      await client.query('COMMIT');
      return { scan, order: updatedOrder, tag_status: 'RESERVED', item_status: 'RESERVED' };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
