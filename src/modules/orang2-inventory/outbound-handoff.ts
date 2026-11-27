import type { PoolClient } from 'pg';

export type ShipmentSource =
  | { type: 'PICKING_ORANG1' | 'OUTBOUND_PICKING'; order_id: string }
  | { type: 'POS'; sale_id: string }
  | { type: 'STOK_BEBAS'; authorization_id?: string };

export class HandoffError extends Error {
  constructor(public statusCode: number, message: string, public errorCode = 'SHIPMENT_SOURCE_CONFLICT') {
    super(message);
  }
}

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export function shipmentSource(input: unknown): ShipmentSource {
  if (input === undefined || input === null) {
    throw new HandoffError(409, 'Muat ulang halaman dan pilih sumber Pengiriman.', 'SHIPMENT_SOURCE_REQUIRED');
  }
  const source = input as Record<string, unknown>;
  const type = source.type;
  if ((type === 'PICKING_ORANG1' || type === 'OUTBOUND_PICKING') && typeof source.order_id === 'string' && uuid.test(source.order_id)) {
    return { type, order_id: source.order_id.toLowerCase() };
  }
  if (type === 'POS' && typeof source.sale_id === 'string' && uuid.test(source.sale_id)) {
    return { type, sale_id: source.sale_id.toLowerCase() };
  }
  if (type === 'STOK_BEBAS' && source.order_id == null && source.sale_id == null) {
    if (source.authorization_id === undefined) return { type };
    if (typeof source.authorization_id === 'string' && uuid.test(source.authorization_id)) {
      return { type, authorization_id: source.authorization_id.toLowerCase() };
    }
  }
  throw new HandoffError(400, 'Jenis atau identitas sumber Pengiriman tidak valid.', 'SHIPMENT_SOURCE_INVALID');
}

export function sourceId(source: ShipmentSource) {
  if ('order_id' in source) return source.order_id;
  if (source.type === 'POS') return source.sale_id;
  return source.authorization_id ?? null;
}

type Item = {
  tag_id: string;
  item_id: string;
  epc: string;
  tag_status: string;
  item_status: string;
  location_type: string;
};

// A sale is current only until another quantity movement supersedes it. POS
// handoff is registered separately because POS already debited the ledger.
const currentPosMovement = `
    m.movement_type = 'POS_SALE' AND m.qty_change < 0
    AND NOT EXISTS (
      SELECT 1 FROM public.stock_movements later
      WHERE later.tag_id = m.tag_id AND later.qty_change <> 0
        AND (later.created_at, later.id) > (m.created_at, m.id)
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.stock_movements returned
      WHERE returned.tag_id = m.tag_id AND returned.reference_doc = m.reference_doc
        AND returned.movement_type = 'RETURN_RESTOCK'
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.audit_logs a
      WHERE a.action = 'OUTBOUND_HANDOFF' AND a.payload->>'source_type' = 'POS'
        AND a.payload->>'source_id' = s.id::text AND (a.payload->'tag_ids') ? m.tag_id::text
    )`;

export const posOrdersForHandoff = `
  SELECT s.id, s.invoice_or_resi, array_agg(t.epc ORDER BY t.epc) AS epcs
  FROM public.sales s
  JOIN public.stock_movements m ON m.reference_doc = s.invoice_or_resi
  JOIN public.tags t ON t.id = m.tag_id
  JOIN public.items i ON i.tag_id = t.id AND i.product_id = m.product_id
  WHERE s.order_type = 'POS' AND s.payment_status = 'PAID'
    AND t.status IN ('RESERVED', 'AUTHORIZED_OUT')
    AND i.status IN ('IN_STOCK', 'RESERVED', 'AUTHORIZED_OUT')
    AND ${currentPosMovement}
  GROUP BY s.id ORDER BY s.created_at DESC, s.id LIMIT 50`;

// Picking, packing and cancellation all serialize on the same order row.
// Acquire it before locking any EPCs, and read Packing after taking the lock.
export async function lockShipmentSource(client: PoolClient, source: ShipmentSource) {
  if (source.type === 'STOK_BEBAS') return null;
  if (source.type === 'POS') {
    const { rows: [sale] } = await client.query<{ id: string; invoice_or_resi: string }>(`
      SELECT id, invoice_or_resi FROM public.sales
      WHERE id = $1 AND order_type = 'POS' AND payment_status = 'PAID' FOR UPDATE`, [source.sale_id]);
    if (!sale) throw new HandoffError(409, 'Penjualan POS tidak ditemukan atau belum dibayar.');
    return sale;
  }
  const table = source.type === 'PICKING_ORANG1' ? 'picking_orders' : 'outbound_picking_orders';
  const { rows: [order] } = await client.query<{ status: string }>(
    `SELECT status FROM public.${table} WHERE id = $1 FOR UPDATE`, [source.order_id]);
  if (order?.status !== 'SIAP_PACKING') {
    throw new HandoffError(409, 'Order sumber tidak siap diproses untuk Pengiriman.');
  }
  if (source.type === 'PICKING_ORANG1') {
    const { rowCount } = await client.query(`
      SELECT 1 FROM public.picking_packing WHERE order_id = $1 AND status = 'SELESAI_PACKING'`, [source.order_id]);
    if (rowCount !== 1) throw new HandoffError(409, 'Packing order sumber belum selesai.');
  }
  return null;
}

// Called only after the source and actual tag/item rows have been locked.
export async function validateShipmentItems(client: PoolClient, source: ShipmentSource, items: Item[]) {
  const tagIds = items.map(item => item.tag_id);
  const { rows } = await client.query<{
    tag_id: string;
    picking_owner: string | null;
    outbound_owner: string | null;
    latest_movement: string | null;
    pos_eligible: boolean;
    preauthorized: boolean;
    already_handed_off: boolean;
  }>(`
    SELECT t.id AS tag_id,
      (SELECT ps.order_id FROM public.picking_scans ps
        WHERE (ps.tag_id = t.id OR ps.item_id = i.id) AND ps.released_at IS NULL LIMIT 1) AS picking_owner,
      (SELECT pi.order_id FROM public.outbound_picking_items pi
        JOIN public.outbound_picking_orders po ON po.id = pi.order_id
        WHERE (pi.tag_id = t.id OR pi.item_id = i.id)
          AND po.status IN ('MENUNGGU_PICKING', 'SEDANG_DIAMBIL', 'SIAP_PACKING')
        ORDER BY pi.scanned_at DESC NULLS LAST, po.created_at DESC, pi.id LIMIT 1) AS outbound_owner,
      (SELECT m.movement_type FROM public.stock_movements m WHERE m.tag_id = t.id AND m.qty_change <> 0
        ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS latest_movement,
      EXISTS (
        SELECT 1 FROM public.sales s JOIN public.stock_movements m ON m.reference_doc = s.invoice_or_resi
        WHERE s.id = $2 AND m.tag_id = t.id AND m.product_id = i.product_id AND ${currentPosMovement}
      ) AS pos_eligible,
      EXISTS (
        SELECT 1 FROM public.audit_logs a WHERE a.id = $3 AND a.action = 'OUTBOUND_PREAUTHORIZED'
          AND (a.payload->'tag_ids') ? t.id::text AND a.created_at = t.updated_at AND a.created_at = i.updated_at
      ) AS preauthorized,
      EXISTS (
        SELECT 1 FROM public.audit_logs a WHERE a.action = 'OUTBOUND_HANDOFF'
          AND a.payload->>'source_type' = $4 AND a.payload->>'source_id' = $5
          AND (a.payload->'tag_ids') ? t.id::text
      ) AS already_handed_off
    FROM public.tags t JOIN public.items i ON i.tag_id = t.id WHERE t.id = ANY($1::uuid[])
  `, [tagIds, source.type === 'POS' ? source.sale_id : null, source.type === 'STOK_BEBAS' ? source.authorization_id ?? null : null,
    source.type, sourceId(source)]);
  const evidence = new Map(rows.map(row => [row.tag_id, row]));
  for (const item of items) {
    const state = evidence.get(item.tag_id);
    const paired = item.tag_status === item.item_status;
    const reserved = paired && ['RESERVED', 'AUTHORIZED_OUT'].includes(item.tag_status);
    let valid = false;
    if (state && !state.already_handed_off && state.latest_movement !== 'OUTBOUND_SHIPMENT') {
      switch (source.type) {
        case 'PICKING_ORANG1':
          valid = reserved && state.picking_owner === source.order_id && !state.outbound_owner
            && state.latest_movement !== 'POS_SALE';
          break;
        case 'OUTBOUND_PICKING':
          valid = reserved && state.outbound_owner === source.order_id && !state.picking_owner
            && state.latest_movement !== 'POS_SALE';
          break;
        case 'POS':
          valid = state.pos_eligible && !state.picking_owner && !state.outbound_owner
            && ['RESERVED', 'AUTHORIZED_OUT'].includes(item.tag_status)
            && ['IN_STOCK', 'RESERVED', 'AUTHORIZED_OUT'].includes(item.item_status);
          break;
        case 'STOK_BEBAS':
          valid = paired && item.location_type === 'RACK' && !state.picking_owner && !state.outbound_owner
            && state.latest_movement !== 'POS_SALE'
            && (item.tag_status === 'IN_STOCK' || (item.tag_status === 'AUTHORIZED_OUT' && state.preauthorized));
      }
    }
    if (!valid) {
      let detail = '';
      if (item.tag_status === 'ENCODED' || !item.location_type) {
        detail = ' (masih berstatus ENCODED / belum dilakukan Putaway ke Rak Penyimpanan)';
      } else if (source.type === 'STOK_BEBAS' && (state?.picking_owner || state?.outbound_owner || item.tag_status === 'RESERVED')) {
        detail = ` (status ${item.tag_status} — sedang terikat pada Order Picking, pilih Order Picking terkait pada Sumber Pengiriman)`;
      } else if (item.tag_status === 'EXITED') {
        detail = ' (barang sudah keluar gerbang / EXITED)';
      } else if (state?.already_handed_off || state?.latest_movement === 'OUTBOUND_SHIPMENT') {
        detail = ' (sudah diterbitkan dalam pengiriman Outbound sebelumnya)';
      }
      throw new HandoffError(409, `EPC ${item.epc} tidak tersedia untuk sumber Pengiriman yang dipilih${detail}.`);
    }
  }

  if ('order_id' in source) {
    const links = source.type === 'PICKING_ORANG1'
      ? 'public.picking_scans WHERE order_id = $1 AND released_at IS NULL'
      : 'public.outbound_picking_items WHERE order_id = $1 AND is_scanned';
    const { rows: members } = await client.query<{ tag_id: string; item_id: string; epc: string }>(
      `SELECT tag_id, item_id, epc FROM ${links} AND tag_id = ANY($2::uuid[])`, [source.order_id, tagIds]);
    const byTag = new Map(members.map(member => [member.tag_id, member]));
    if (items.some(item => byTag.get(item.tag_id)?.item_id !== item.item_id || byTag.get(item.tag_id)?.epc !== item.epc)) {
      throw new HandoffError(409, 'EPC yang dipilih tidak cocok dengan histori scan order sumber.');
    }
  }
}
