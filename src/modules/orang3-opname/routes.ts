import { FastifyInstance } from 'fastify';
import { db, isPostgresConnected, memoryStore } from '../../config/db';
import { publishRealtimeEvent } from '../../config/mqtt';

/**
 * ============================================================================
 * MODUL ORANG 3: STOCK OPNAME HANDHELD RFID & REKONSILIASI SELISIH
 * ============================================================================
 */
export async function orang3OpnameRoutes(app: FastifyInstance) {
  // 1. GET Daftar Sesi Stock Opname
  app.get('/api/stocktake/sessions', async () => {
    if (isPostgresConnected) {
      const res = await db.query('SELECT * FROM stocktake_sessions ORDER BY created_at DESC');
      return { success: true, data: res.rows };
    }
    return { success: true, data: memoryStore.stocktake_sessions };
  });

  // 2. POST Mulai Sesi Stock Opname Baru & Kirim Daftar EPC Hasil Scan Handheld
  app.post('/api/stocktake/scan-submit', async (request, reply) => {
    const {
      zone_code = 'A1',
      total_expected = 125,
      total_scanned = 124,
      total_matched = 124,
      total_missing = 0,
      total_misplaced = 1,
    } = request.body as {
      zone_code?: string;
      total_expected?: number;
      total_scanned?: number;
      total_matched?: number;
      total_missing?: number;
      total_misplaced?: number;
    };

    const sessionCode = `OPN-${zone_code}-${Date.now().toString().slice(-4)}`;

    if (isPostgresConnected) {
      const res = await db.query(
        `INSERT INTO stocktake_sessions 
          (session_code, zone_code, total_expected, total_scanned, total_matched, total_missing, total_misplaced, status, scanned_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'MENUNGGU_APPROVAL', 1)
         RETURNING *`,
        [sessionCode, zone_code, total_expected, total_scanned, total_matched, total_missing, total_misplaced]
      );
      publishRealtimeEvent(`wms/opname/${sessionCode}/scan`, { session: res.rows[0] });
      return reply.code(201).send({ success: true, data: res.rows[0] });
    }

    const newSession = {
      id: memoryStore.stocktake_sessions.length + 1,
      session_code: sessionCode,
      zone_code,
      total_expected,
      total_scanned,
      total_matched,
      total_missing,
      total_misplaced,
      status: 'MENUNGGU_APPROVAL',
      created_at: new Date().toISOString(),
    };
    memoryStore.stocktake_sessions.unshift(newSession);
    publishRealtimeEvent(`wms/opname/${sessionCode}/scan`, { session: newSession });

    return reply.code(201).send({ success: true, data: newSession });
  });

  // 3. POST Persetujuan Supervisor (Approve Adjustment ke Buku Besar Ledger Orang 2)
  app.post('/api/stocktake/approve', async (request, reply) => {
    const { session_code, product_id, diff_qty, from_rack, to_rack } = request.body as {
      session_code: string;
      product_id: number;
      diff_qty: number;
      from_rack?: string;
      to_rack?: string;
    };

    if (isPostgresConnected) {
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `UPDATE stocktake_sessions SET status = 'DISETUJUI', approved_by = 1 WHERE session_code = $1`,
          [session_code]
        );
        const txCode = `TX-OPN-${Date.now().toString().slice(-4)}`;
        const ledgerRes = await client.query(
          `INSERT INTO stock_movements 
            (tx_code, movement_type, product_id, from_location, to_location, qty, reference_doc, operator_id)
           VALUES ($1, 'STOCKTAKE_ADJUSTMENT', $2, $3, $4, $5, $6, 1)
           RETURNING *`,
          [txCode, product_id, from_rack || 'Audit Opname Fisik', to_rack || 'Koreksi Buku Besar', diff_qty, session_code]
        );
        await client.query('COMMIT');
        publishRealtimeEvent('wms/stock/realtime', {
          event: 'STOCKTAKE_APPROVED',
          session_code,
          ledgerEntry: ledgerRes.rows[0],
        });
        return reply.send({ success: true, ledger: ledgerRes.rows[0] });
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    }

    const prod = memoryStore.products.find((p) => p.id === Number(product_id));
    const txCode = `TX-OPN-${Date.now().toString().slice(-4)}`;
    const newLedger = {
      id: memoryStore.stock_movements.length + 1,
      tx_code: txCode,
      movement_type: 'STOCKTAKE_ADJUSTMENT',
      product_id: Number(product_id),
      sku: prod?.sku || 'SKU-031',
      product_name: prod?.name || 'Produk Audit',
      from_location: from_rack || 'Audit Opname Fisik',
      to_location: to_rack || 'Koreksi Buku Besar',
      qty: Number(diff_qty),
      reference_doc: session_code,
      operator_name: 'Sarah Jenkins (Disetujui)',
      created_at: new Date().toISOString(),
    };
    memoryStore.stock_movements.unshift(newLedger);
    publishRealtimeEvent('wms/stock/realtime', {
      event: 'STOCKTAKE_APPROVED',
      session_code,
      ledgerEntry: newLedger,
    });

    return reply.send({ success: true, ledger: newLedger });
  });
}
