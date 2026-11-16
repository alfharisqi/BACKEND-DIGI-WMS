import { FastifyInstance } from 'fastify';
import { db, isPostgresConnected, memoryStore, getCalculatedLedgerStock } from '../../config/db';
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
      return { status: 'ok', success: true, data: res.rows };
    }
    return { status: 'ok', success: true, data: memoryStore.stocktake_sessions };
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
    } = (request.body || {}) as {
      zone_code?: string;
      total_expected?: number;
      total_scanned?: number;
      total_matched?: number;
      total_missing?: number;
      total_misplaced?: number;
    };

    const sessionCode = `OPN-${zone_code}-${Date.now().toString().slice(-4)}`;

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

    return reply.code(201).send({ status: 'ok', success: true, data: newSession });
  });

  // 3. POST Persetujuan Supervisor (Mendukung /api/stocktake/approve dan /api/opname/reconcile)
  const approveStocktakeHandler = async (request: any, reply: any) => {
    const body = (request.body || {}) as {
      session_code?: string;
      product_id?: number;
      sku?: string;
      diff_qty?: number;
      physical_qty?: number;
      from_rack?: string;
      to_rack?: string;
      notes?: string;
    };

    const prod = body.product_id
      ? memoryStore.products.find((p) => p.id === Number(body.product_id))
      : memoryStore.products.find((p) => p.sku === body.sku) || memoryStore.products[0];

    const currentStock =
      getCalculatedLedgerStock().find((s) => s.product_id === prod?.id)?.current_stock ?? 15;
    const diffQty =
      body.diff_qty !== undefined
        ? Number(body.diff_qty)
        : body.physical_qty !== undefined
        ? Number(body.physical_qty) - currentStock
        : -1;

    const sessionCode = body.session_code || `OPN-${Date.now().toString().slice(-4)}`;
    const txCode = `TX-OPN-${Date.now().toString().slice(-4)}`;
    const newLedger = {
      id: memoryStore.stock_movements.length + 1,
      tx_code: txCode,
      movement_type: 'STOCKTAKE_ADJUSTMENT',
      product_id: prod?.id || 1,
      sku: prod?.sku || body.sku || 'SKU-012',
      product_name: prod?.name || 'Produk Audit',
      from_location: body.from_rack || 'Audit Opname Fisik',
      to_location: body.to_rack || 'Koreksi Buku Besar',
      qty: diffQty,
      reference_doc: body.notes || sessionCode,
      operator_name: 'Sarah Jenkins (Disetujui)',
      created_at: new Date().toISOString(),
    };
    memoryStore.stock_movements.unshift(newLedger);
    publishRealtimeEvent('wms/stock/realtime', {
      event: 'STOCKTAKE_APPROVED',
      session_code: sessionCode,
      ledgerEntry: newLedger,
    });

    return reply.send({
      status: 'ok',
      success: true,
      message: `Penyesuaian opname ${newLedger.sku} (${diffQty}) berhasil dibukukan ke Ledger!`,
      ledger: newLedger,
    });
  };
  app.post('/api/stocktake/approve', approveStocktakeHandler);
  app.post('/api/opname/reconcile', approveStocktakeHandler);
}
