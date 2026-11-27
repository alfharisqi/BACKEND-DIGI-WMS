import type { PoolClient } from 'pg';

type Executor = Pick<PoolClient, 'query'>;
type AuthorizedUnit = { epc: string; tag_id?: string; box_id?: string };

export async function recordGateAuthorization(
  db: Executor, passId: string, units: AuthorizedUnit[], reference: string,
) {
  await db.query(`
    INSERT INTO public.audit_logs (action, entity_type, entity_id, payload, created_at)
    VALUES ('GATE_PASS_AUTHORIZATION', 'gate_pass', $1, $2::jsonb, clock_timestamp())`,
  [passId, JSON.stringify({ reference, units, tag_ids: units.flatMap(unit => unit.tag_id ? [unit.tag_id] : []) })]);
}

export class GateAuthorizationError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
  }
}

type GateSource = {
  saleId: string | null;
  reference: string;
  epcs: string[];
};

const pendingBoxForSale = `
  b.status = 'SHIPPED'
  AND EXISTS (SELECT 1 FROM public.stock_movements m
    WHERE m.tag_id IS NULL AND m.reference_doc = $1 AND m.movement_type = 'POS_SALE'
      AND m.product_id = b.product_id AND m.qty_change = -b.qty_per_box
      AND m.qty_label = b.qty_per_box || ' UNIT (' || b.box_code || ')')
  AND NOT EXISTS (SELECT 1 FROM public.gate_events g
    WHERE g.epc = b.master_epc AND g.direction = 'OUT' AND g.authorization_status = 'AUTHORIZED_OUT')`;

export async function pendingPosBoxEpcs(db: Executor, reference: string) {
  const { rows } = await db.query<{ epc: string }>(`
    SELECT b.master_epc AS epc FROM public.boxes b WHERE ${pendingBoxForSale}
    ORDER BY b.master_epc`, [reference]);
  return rows.map(row => row.epc);
}

export async function lockGateAuthorization(db: Executor, { saleId, reference, epcs }: GateSource) {
  if (saleId && !reference) {
    const { rows: [document] } = await db.query<{ invoice_or_resi: string }>(`
      SELECT invoice_or_resi FROM public.sales WHERE id = $1`, [saleId]);
    if (!document) throw new GateAuthorizationError(409, 'Dokumen sumber Gate Pass tidak ditemukan.');
    reference = document.invoice_or_resi;
  }
  const { rows: orders } = await db.query<{ id: string; status: string }>(`
    SELECT id, status FROM public.picking_orders
    WHERE order_number = $1 OR 'RESI-' || order_number = $1
    ORDER BY id FOR UPDATE`, [reference]);
  if (orders.length > 1 || orders.some(order => order.status !== 'SIAP_PACKING')) {
    throw new GateAuthorizationError(409, 'Pesanan Picking pada referensi ini belum menyelesaikan Packing atau sudah dibatalkan.');
  }
  const pickingId = orders[0]?.id ?? null;
  if (pickingId && !(await db.query(`
    SELECT 1 FROM public.picking_packing WHERE order_id = $1 AND status = 'SELESAI_PACKING'`, [pickingId])).rowCount) {
    throw new GateAuthorizationError(409, 'Packing harus difinalisasi sebelum menerbitkan Gate Pass.');
  }

  const { rows: sales } = await db.query<{ id: string; invoice_or_resi: string; order_type: string; payment_status: string }>(`
    SELECT id, invoice_or_resi, order_type, payment_status FROM public.sales
    WHERE ($1::uuid IS NOT NULL AND id = $1) OR ($1::uuid IS NULL AND invoice_or_resi = $2)
    ORDER BY id FOR NO KEY UPDATE`, [saleId, reference]);
  const sale = sales[0];
  if (sales.length > 1 || (saleId && !sale) || (sale && (
    (reference && sale.invoice_or_resi !== reference) || sale.payment_status !== 'PAID'
    || !['POS', 'OUTBOUND_SHIPMENT'].includes(sale.order_type)
  )) || (pickingId && sale?.order_type === 'POS')) {
    throw new GateAuthorizationError(409, 'Dokumen sumber Gate Pass tidak cocok atau belum dibayar.');
  }
  const exactReference = sale?.invoice_or_resi || reference;
  if (!epcs.length && (pickingId || sale)) {
    const { rows } = await db.query<{ epc: string }>(`
      SELECT ps.epc FROM public.picking_scans ps JOIN public.tags t ON t.id = ps.tag_id
      WHERE ps.order_id = $1 AND ps.released_at IS NULL AND t.status = 'AUTHORIZED_OUT'
      UNION
      SELECT t.epc FROM public.tags t JOIN public.stock_movements m ON m.tag_id = t.id
      WHERE $2::text IS NOT NULL AND m.reference_doc = $2 AND m.qty_change < 0
        AND t.status IN ('RESERVED', 'AUTHORIZED_OUT')
        AND NOT EXISTS (SELECT 1 FROM public.stock_movements rm WHERE rm.tag_id = m.tag_id
          AND rm.reference_doc = m.reference_doc AND rm.movement_type = 'RETURN_RESTOCK')
      ORDER BY epc`, [pickingId, sale?.invoice_or_resi ?? null]);
    epcs = rows.map(row => row.epc);
    if (sale?.order_type === 'POS') epcs.push(...await pendingPosBoxEpcs(db, exactReference));
    if (!epcs.length) throw new GateAuthorizationError(409, 'Tidak ada EPC yang masih memenuhi syarat untuk dokumen ini.');
  }
  if (!epcs.length) return { saleId: null, reference: exactReference, tags: [], units: [] };

  const { rows: tags } = await db.query<{
    epc: string; tag_id: string; item_id: string; tag_status: string; item_status: string; in_rack: boolean;
  }>(`
    SELECT t.epc, t.id AS tag_id, i.id AS item_id, t.status AS tag_status, i.status AS item_status,
      l.location_type = 'RACK' AS in_rack
    FROM public.tags t JOIN public.items i ON i.tag_id = t.id
    LEFT JOIN public.locations l ON l.id = i.location_id
    WHERE t.epc = ANY($1::text[])
      AND (NOT $2::boolean OR (t.status = i.status AND t.status IN ('IN_STOCK', 'AUTHORIZED_OUT')))
    ORDER BY t.epc FOR UPDATE OF t, i`, [epcs, !sale && !pickingId]);
  const { rows: boxes } = await db.query<{ epc: string; box_id: string }>(`
    SELECT b.master_epc AS epc, b.id AS box_id FROM public.boxes b
    WHERE b.master_epc = ANY($1::text[]) ORDER BY b.master_epc FOR UPDATE`, [epcs.filter(epc => !tags.some(tag => tag.epc === epc))]);
  if (new Set([...tags, ...boxes].map(unit => unit.epc)).size !== epcs.length || tags.length + boxes.length !== epcs.length) {
    throw new GateAuthorizationError(409, 'Daftar EPC berisi barang yang belum terhubung ke stok atau Box.');
  }

  // This statement sees handoffs that committed while issuance waited for the EPC locks.
  const { rows: owners } = await db.query<{
    tag_id: string; picking_id: string | null; outbound_id: string | null; picking_member: boolean;
    movement_type: string | null; movement_ref: string | null; handed_off: boolean; pos_returned: boolean;
    same_manual_authorization: boolean;
  }>(`
    SELECT t.id AS tag_id, ps.order_id AS picking_id, outbound.order_id AS outbound_id,
      ps.item_id = i.id AND ps.tag_id = t.id AND ps.product_id = i.product_id AND ps.epc = t.epc AS picking_member,
      movement.movement_type, movement.reference_doc AS movement_ref,
      EXISTS (
        SELECT 1 FROM public.audit_logs a WHERE a.action = 'OUTBOUND_HANDOFF' AND a.entity_id = $2::text
          AND a.payload->>'source_type' IN ('PICKING_ORANG1', 'OUTBOUND_PICKING')
          AND a.payload->>'source_id' = coalesce(ps.order_id, outbound.order_id)::text
          AND (a.payload->'tag_ids') ? t.id::text
      ) AS handed_off,
      EXISTS (
        SELECT 1 FROM public.stock_movements rm WHERE rm.tag_id = t.id
          AND rm.reference_doc = $3 AND rm.movement_type = 'RETURN_RESTOCK'
      ) AS pos_returned,
      coalesce(previous.same_reference, false) AS same_manual_authorization
    FROM public.tags t JOIN public.items i ON i.tag_id = t.id
    LEFT JOIN public.picking_scans ps ON (ps.tag_id = t.id OR ps.item_id = i.id) AND ps.released_at IS NULL
    LEFT JOIN LATERAL (
      SELECT pi.order_id FROM public.outbound_picking_items pi
      JOIN public.outbound_picking_orders po ON po.id = pi.order_id
      WHERE (pi.tag_id = t.id OR pi.item_id = i.id)
        AND po.status IN ('MENUNGGU_PICKING', 'SEDANG_DIAMBIL', 'SIAP_PACKING')
      LIMIT 1
    ) outbound ON true
    LEFT JOIN LATERAL (
      SELECT CASE WHEN m.qty_change < 0 THEN m.movement_type ELSE NULL END AS movement_type,
        m.reference_doc FROM public.stock_movements m
      WHERE m.tag_id = t.id AND m.qty_change <> 0
      ORDER BY m.created_at DESC, m.id DESC LIMIT 1
    ) movement ON true
    LEFT JOIN LATERAL (
      SELECT a.payload->>'reference' = $3 AND g.sale_id IS NULL
        AND a.created_at >= greatest(t.updated_at, i.updated_at) AS same_reference
      FROM public.audit_logs a JOIN public.gate_passes g ON g.id::text = a.entity_id
      WHERE a.action = 'GATE_PASS_AUTHORIZATION' AND (a.payload->'tag_ids') ? t.id::text
      ORDER BY a.created_at DESC, a.id DESC LIMIT 1
    ) previous ON true
    WHERE t.id = ANY($1::uuid[])`, [tags.map(tag => tag.tag_id), sale?.id ?? null, exactReference]);
  const byTag = new Map(owners.map(row => [row.tag_id, row]));
  for (const tag of tags) {
    const owner = byTag.get(tag.tag_id);
    const paired = tag.tag_status === tag.item_status;
    const matchesPicking = Boolean(pickingId && owner?.picking_id === pickingId && owner.picking_member && !owner.outbound_id);
    let valid = false;
    if (owner && owner.movement_type === 'OUTBOUND_SHIPMENT') {
      valid = sale?.order_type === 'OUTBOUND_SHIPMENT' && owner.movement_ref === exactReference
        && ((!pickingId && !owner.picking_id && !owner.outbound_id)
          || matchesPicking || (!pickingId && owner.handed_off))
        && paired && tag.tag_status === 'AUTHORIZED_OUT';
    } else if (owner && sale?.order_type === 'POS') {
      valid = !owner.picking_id && !owner.outbound_id && !owner.pos_returned
        && owner.movement_type === 'POS_SALE' && owner.movement_ref === exactReference
        && ['RESERVED', 'AUTHORIZED_OUT'].includes(tag.tag_status)
        && ['IN_STOCK', 'RESERVED', 'AUTHORIZED_OUT'].includes(tag.item_status);
    } else if (owner && !sale && owner.movement_type !== 'POS_SALE') {
      valid = paired && (pickingId
        ? matchesPicking && tag.tag_status === 'AUTHORIZED_OUT'
        : !owner.picking_id && !owner.outbound_id && tag.in_rack
          && (tag.tag_status === 'IN_STOCK' || (tag.tag_status === 'AUTHORIZED_OUT' && owner.same_manual_authorization)));
    }
    if (!valid) throw new GateAuthorizationError(409, `EPC ${tag.epc} tidak tersedia untuk sumber Gate Pass ini.`);
  }

  if (boxes.length) {
    const pendingBoxes = sale?.order_type === 'POS' ? await pendingPosBoxEpcs(db, exactReference) : [];
    if (boxes.some(box => !pendingBoxes.includes(box.epc))) {
      throw new GateAuthorizationError(409, 'Box tidak terdaftar pada penjualan POS ini atau sudah keluar lewat gerbang.');
    }
  }
  const units = [
    ...tags.map(({ epc, tag_id }) => ({ epc, tag_id })),
    ...boxes.map(({ epc, box_id }) => ({ epc, box_id })),
  ];
  return { saleId: sale?.id ?? null, reference: exactReference, tags, units };
}
