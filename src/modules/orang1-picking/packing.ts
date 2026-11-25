import type { Pool, PoolClient } from 'pg';
import { PackingChecklist, PickingError, packingFields } from './contract';
import type { WarehouseSession } from '../warehouse-session';
import { selectOrders, verifyPickingAccount } from './repository';

interface SavedPacking extends PackingChecklist {
  status: 'MENUNGGU_PACKING' | 'SELESAI_PACKING';
  revision: number;
  updated_at: Date;
  checked_by: string | null;
  checked_by_name: string | null;
  completed_at: Date | null;
  completed_by: string | null;
  completed_by_name: string | null;
}

const blankChecklist: PackingChecklist = {
  quantity_checked: false, epc_checked: false, condition_checked: false,
  packaging_checked: false, label_checked: false,
};

function checklistOf(saved?: SavedPacking): PackingChecklist {
  if (!saved) return { ...blankChecklist };
  return {
    quantity_checked: saved.quantity_checked, epc_checked: saved.epc_checked,
    condition_checked: saved.condition_checked, packaging_checked: saved.packaging_checked,
    label_checked: saved.label_checked,
  };
}

async function savedPacking(db: PoolClient, orderId: string) {
  const { rows } = await db.query<SavedPacking>(`
    SELECT p.*, coalesce(saved.actor_id, p.checked_by) AS checked_by, saved.actor_name AS checked_by_name,
      coalesce(done.actor_id, p.completed_by) AS completed_by, done.actor_name AS completed_by_name
    FROM public.picking_packing p
    LEFT JOIN public.picking_packing_events saved ON saved.order_id = p.order_id
      AND saved.revision = p.revision - CASE WHEN p.status = 'SELESAI_PACKING' THEN 1 ELSE 0 END
      AND saved.action = 'CHECKLIST_SAVED'
    LEFT JOIN public.picking_packing_events done ON done.order_id = p.order_id
      AND done.action = 'PACKING_COMPLETED'
    WHERE p.order_id = $1`, [orderId]);
  return rows[0];
}

async function completePicking(db: PoolClient, orderId: string) {
  const { rows } = await db.query<{ complete: boolean }>(`
    SELECT o.status = 'SIAP_PACKING'
      AND EXISTS (SELECT 1 FROM public.picking_order_lines WHERE order_id = o.id)
      AND NOT EXISTS (
        SELECT 1 FROM public.picking_order_lines line
        WHERE line.order_id = o.id AND line.requested_qty <> (
          SELECT count(*) FROM public.picking_scans s
          JOIN public.items i ON i.id = s.item_id AND i.product_id = s.product_id AND i.tag_id = s.tag_id
          JOIN public.tags t ON t.id = s.tag_id AND t.epc = s.epc
          WHERE s.order_id = line.order_id AND s.product_id = line.product_id
            AND s.released_at IS NULL
            AND i.status IN ('RESERVED', 'AUTHORIZED_OUT', 'EXITED')
            AND t.status IN ('RESERVED', 'AUTHORIZED_OUT', 'EXITED')
        )
      ) AS complete
    FROM public.picking_orders o WHERE o.id = $1`, [orderId]);
  return rows[0]?.complete ?? false;
}

async function packingView(db: PoolClient, orderId: string) {
  const [order] = await selectOrders(db, null, orderId);
  if (!order) throw new PickingError(404, 'Pesanan picking tidak ditemukan.');
  const saved = await savedPacking(db, orderId);
  return {
    order, status: saved?.status ?? 'MENUNGGU_PACKING', picking_complete: await completePicking(db, orderId),
    checklist: checklistOf(saved), revision: saved?.revision ?? 0,
    checked_by: saved?.checked_by ?? null, checked_by_name: saved?.checked_by_name ?? null,
    updated_at: saved?.updated_at ?? null, completed_at: saved?.completed_at ?? null,
    completed_by: saved?.completed_by ?? null, completed_by_name: saved?.completed_by_name ?? null,
  };
}

type Change =
  | { action: 'CHECKLIST_SAVED'; revision: number; checklist: PackingChecklist }
  | { action: 'PACKING_COMPLETED'; revision: number };

export class PackingRepository {
  constructor(private readonly pool: Pool) {}

  private async transaction<T>(sql: string, work: (db: PoolClient) => Promise<T>) {
    const db = await this.pool.connect();
    try {
      await db.query(sql);
      await db.query("SET LOCAL lock_timeout = '5s'");
      const result = await work(db);
      await db.query('COMMIT');
      return result;
    } catch (error) {
      await db.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      db.release();
    }
  }

  details(orderId: string, session: WarehouseSession) {
    return this.transaction('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', async db => {
      await verifyPickingAccount(db, session);
      return packingView(db, orderId);
    });
  }

  change(orderId: string, session: WarehouseSession, change: Change) {
    return this.transaction('BEGIN', async db => {
      const actor = await verifyPickingAccount(db, session, true);
      const actorId = session.id;
      // Picking, checklist saves, and finalization share this serialization point.
      const order = await db.query('SELECT id FROM public.picking_orders WHERE id = $1 FOR UPDATE', [orderId]);
      if (!order.rowCount) throw new PickingError(404, 'Pesanan picking tidak ditemukan.');
      const saved = await savedPacking(db, orderId);
      if (saved?.status === 'SELESAI_PACKING') {
        if (change.action === 'PACKING_COMPLETED') return packingView(db, orderId);
        throw new PickingError(409, 'Packing sudah selesai dan checklist terkunci.');
      }
      if ((saved?.revision ?? 0) !== change.revision) {
        throw new PickingError(409, 'Checklist sudah berubah. Muat ulang sebelum menyimpan.');
      }
      await db.query('SELECT product_id FROM public.picking_order_lines WHERE order_id=$1 ORDER BY product_id FOR SHARE', [orderId]);
      // Protect the reservation state against an independent release or item/tag change until commit.
      await db.query(`SELECT s.id FROM public.picking_scans s
        JOIN public.items i ON i.id = s.item_id JOIN public.tags t ON t.id = s.tag_id
        WHERE s.order_id = $1 ORDER BY s.tag_id FOR SHARE OF s, i, t`, [orderId]);
      if (!await completePicking(db, orderId)) {
        throw new PickingError(409, 'Lengkapi Picking dan pastikan semua EPC masih direservasi sebelum Packing.');
      }

      const revision = change.revision + 1;
      const checklist = change.action === 'CHECKLIST_SAVED' ? change.checklist : checklistOf(saved);
      if (change.action === 'PACKING_COMPLETED') {
        if (!packingFields.every(field => checklist[field])) {
          throw new PickingError(409, 'Simpan semua pemeriksaan checklist sebelum menyelesaikan Packing.');
        }
        await db.query(`UPDATE public.picking_packing SET status='SELESAI_PACKING',
          revision=$2, updated_at=now(), completed_at=now(), completed_by=$3 WHERE order_id=$1`,
        [orderId, revision, actorId]);

        // Otomatis otorisasi seluruh EPC pada order ini menjadi AUTHORIZED_OUT
        // dan terbitkan Gate Pass otomatis sehingga di gerbang cukup scan EPC barang langsung!
        const orderMeta = (await db.query<{ order_number: string }>(
          `SELECT order_number FROM public.picking_orders WHERE id = $1`,
          [orderId]
        )).rows[0];

        const scannedRows = (await db.query<{ item_id: string; tag_id: string; epc: string }>(
          `SELECT item_id, tag_id, epc
           FROM public.picking_scans
           WHERE order_id = $1 AND released_at IS NULL`,
          [orderId]
        )).rows;

        if (scannedRows.length > 0) {
          const tagIds = scannedRows.map(r => r.tag_id);
          const itemIds = scannedRows.map(r => r.item_id);

          await db.query(
            `UPDATE public.tags
             SET status = 'AUTHORIZED_OUT', updated_at = now()
             WHERE id = ANY($1::uuid[]) AND status = 'RESERVED'`,
            [tagIds]
          );

          await db.query(
            `UPDATE public.items
             SET status = 'AUTHORIZED_OUT', updated_at = now()
             WHERE id = ANY($1::uuid[]) AND status = 'RESERVED'`,
            [itemIds]
          );

          const refResi = orderMeta?.order_number || `PACK-${orderId.slice(0, 8).toUpperCase()}`;
          const existingPass = await db.query(
            `SELECT id FROM public.gate_passes WHERE reference_resi = $1 AND status = 'ACTIVE' LIMIT 1`,
            [refResi]
          );

          if (existingPass.rowCount === 0) {
            const passCode = `GP-PACK-${Math.floor(1000 + Math.random() * 9000)}`;
            await db.query(
              `INSERT INTO public.gate_passes (pass_code, reference_resi, authorized_by, status, valid_until, created_at)
               VALUES ($1, $2, $3, 'ACTIVE', now() + interval '24 hours', now())`,
              [passCode, refResi, actorId]
            );
          }
        }
      } else {
        await db.query(`INSERT INTO public.picking_packing(
          order_id, quantity_checked, epc_checked, condition_checked, packaging_checked, label_checked, revision, checked_by
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT(order_id) DO UPDATE SET quantity_checked=excluded.quantity_checked,
          epc_checked=excluded.epc_checked, condition_checked=excluded.condition_checked,
          packaging_checked=excluded.packaging_checked, label_checked=excluded.label_checked,
          revision=excluded.revision, checked_by=excluded.checked_by, updated_at=now()`,
        [orderId, ...packingFields.map(field => checklist[field]), revision, actorId]);
      }
      await db.query(`INSERT INTO public.picking_packing_events(order_id, revision, action, actor_id, actor_name, checklist)
        VALUES($1,$2,$3,$4,$5,$6)`, [orderId, revision, change.action, actorId, actor.name, checklist]);
      return packingView(db, orderId);
    });
  }
}
