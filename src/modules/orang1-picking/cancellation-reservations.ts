import type { PoolClient } from 'pg';
import { PickingError } from './contract';

export const reservationJoins = `
  LEFT JOIN public.tags t ON t.id = ps.tag_id
  LEFT JOIN public.items i ON i.id = ps.item_id
  LEFT JOIN public.locations l ON l.id = i.location_id`;

export const releasableReservation = `
  t.status = 'RESERVED' AND i.status = 'RESERVED' AND i.tag_id = ps.tag_id
  AND i.product_id = ps.product_id AND t.epc = ps.epc
  AND i.location_id = ps.location_id AND l.location_type = 'RACK'
  AND l.code = ps.location_code AND l.name = ps.location_name
  AND NOT EXISTS (
    SELECT 1 FROM public.outbound_picking_items pi
    JOIN public.outbound_picking_orders po ON po.id = pi.order_id
    WHERE (pi.tag_id = ps.tag_id OR pi.item_id = ps.item_id)
      AND po.status IN ('MENUNGGU_PICKING', 'SEDANG_DIAMBIL', 'SIAP_PACKING')
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.stock_movements m
    WHERE m.tag_id = ps.tag_id AND m.created_at >= ps.scanned_at
      AND m.qty_change < 0 AND m.movement_type IN ('POS_SALE', 'OUTBOUND_SHIPMENT')
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.gate_events ge WHERE (ge.tag_id = ps.tag_id OR ge.epc = ps.epc)
      AND ge.event_time >= ps.scanned_at AND ge.direction = 'OUT' AND ge.authorization_status = 'AUTHORIZED_OUT'
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.audit_logs a
    WHERE a.action IN ('OUTBOUND_HANDOFF', 'OUTBOUND_PREAUTHORIZED', 'GATE_PASS_AUTHORIZATION')
      AND a.created_at >= ps.scanned_at AND (a.payload->'tag_ids') ? ps.tag_id::text
  )`;

type Reservation = {
  scan_id: string;
  tag_id: string;
  item_id: string;
  epc: string;
  location_id: string;
  location_code: string;
  location_name: string;
  eligible: boolean;
};

export async function releaseReservations(client: PoolClient, orderId: string, confirmedScanIds: string[]) {
  // The caller holds the order lock. Lock the actual tags and items before
  // rechecking ownership and downstream evidence in a fresh statement.
  await client.query(`
    SELECT ps.id FROM public.picking_scans ps
    JOIN public.tags t ON t.id = ps.tag_id
    JOIN public.items i ON i.id = ps.item_id
    JOIN public.locations l ON l.id = ps.location_id
    WHERE ps.order_id = $1 AND ps.released_at IS NULL
    ORDER BY t.epc FOR UPDATE OF t, i FOR SHARE OF l`, [orderId]);
  const { rows } = await client.query<Reservation>(`
    SELECT ps.id AS scan_id, ps.tag_id, ps.item_id, ps.epc,
      ps.location_id, l.code AS location_code, l.name AS location_name,
      (${releasableReservation}) IS TRUE AS eligible
    FROM public.picking_scans ps ${reservationJoins}
    WHERE ps.order_id = $1 AND ps.released_at IS NULL ORDER BY ps.epc`, [orderId]);
  if (!rows.length || rows.some(row => !row.eligible)) {
    throw new PickingError(409, 'Setidaknya satu reservasi EPC tidak dapat dilepas. Periksa status dan rak barang.');
  }
  const confirmed = new Set(confirmedScanIds);
  if (confirmed.size !== rows.length || rows.some(row => !confirmed.has(row.scan_id))) {
    throw new PickingError(409, 'Daftar reservasi berubah. Muat ulang pesanan dan konfirmasi pengembalian fisik kembali.');
  }

  const tags = await client.query(`
    UPDATE public.tags SET status = 'IN_STOCK', updated_at = now()
    WHERE id = ANY($1::uuid[]) AND status = 'RESERVED'`, [rows.map(row => row.tag_id)]);
  const items = await client.query(`
    UPDATE public.items SET status = 'IN_STOCK', updated_at = now()
    WHERE id = ANY($1::uuid[]) AND status = 'RESERVED'`, [rows.map(row => row.item_id)]);
  const scans = await client.query(`
    UPDATE public.picking_scans SET released_at = clock_timestamp()
    WHERE order_id = $1 AND id = ANY($2::uuid[]) AND released_at IS NULL
    RETURNING id, released_at`, [orderId, confirmedScanIds]);
  if ([tags, items, scans].some(result => result.rowCount !== rows.length)) {
    throw new PickingError(409, 'Reservasi EPC telah berubah.');
  }
  const releasedAt = new Map(scans.rows.map(row => [row.id, row.released_at]));
  return rows.map(({ eligible, ...row }) => ({ ...row, released_at: releasedAt.get(row.scan_id) }));
}
