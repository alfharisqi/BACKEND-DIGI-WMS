import { FastifyInstance } from 'fastify';
import { db, isPostgresConnected, memoryStore, getCalculatedLedgerStock } from '../../config/db';
import { publishRealtimeEvent } from '../../config/mqtt';

/**
 * ============================================================================
 * MODUL ORANG 2: PENYIMPANAN RAK (PUTAWAY), STOK & IMMUTABLE STOCK LEDGER
 * ============================================================================
 */
export async function orang2InventoryRoutes(app: FastifyInstance) {
  // 1. GET Denah Lokasi Rak Gudang
  app.get('/api/locations', async () => {
    if (isPostgresConnected) {
      const res = await db.query(`
        SELECT l.*, COUNT(i.id)::INT AS items_count
        FROM locations l
        LEFT JOIN items i ON l.id = i.location_id
        GROUP BY l.id
        ORDER BY l.zone_code ASC
      `);
      return { status: 'ok', success: true, data: res.rows };
    }
    const enrichedLocations = memoryStore.locations.map((l) => ({
      ...l,
      code: l.rack_name,
      zone: `Zona ${l.zone_code}`,
      name: l.zone_description,
      occupied: l.items_count,
      capacity: l.max_capacity,
    }));
    return { status: 'ok', success: true, data: enrichedLocations };
  });

  // 2. GET Ringkasan Stok Barang (Dihitung dari View Buku Besar)
  app.get('/api/inventory/stock', async () => {
    if (isPostgresConnected) {
      const res = await db.query('SELECT * FROM v_product_stock_ledger');
      return { status: 'ok', success: true, data: res.rows };
    }
    return { status: 'ok', success: true, data: getCalculatedLedgerStock() };
  });

  // 3. GET Riwayat Buku Besar Mutasi Stok (Mendukung /api/inventory/ledger dan /api/ledger)
  const getLedgerHandler = async () => {
    if (isPostgresConnected) {
      const res = await db.query(`
        SELECT sm.*, p.sku, p.name AS product_name, u.full_name AS operator_name
        FROM stock_movements sm
        JOIN products p ON sm.product_id = p.id
        LEFT JOIN users u ON sm.operator_id = u.id
        ORDER BY sm.created_at DESC
        LIMIT 100
      `);
      return { status: 'ok', success: true, data: res.rows };
    }
    const enrichedLedger = memoryStore.stock_movements.map((m) => ({
      ...m,
      qty_change: m.qty,
      notes: `${m.from_location} → ${m.to_location} (${m.reference_doc})`,
    }));
    return { status: 'ok', success: true, data: enrichedLedger };
  };
  app.get('/api/inventory/ledger', getLedgerHandler);
  app.get('/api/ledger', getLedgerHandler);

  // 4. POST Proses Putaway (Menempatkan Barang ke Rak & Mencatat ke Ledger)
  app.post('/api/inventory/putaway', async (request, reply) => {
    const body = (request.body || {}) as {
      epc?: string;
      epc_code?: string;
      product_id?: number;
      location_id?: number;
      target_location?: string;
      qty?: number;
      reference_doc?: string;
    };

    const epc = body.epc || body.epc_code;
    const product_id = Number(body.product_id || 1);
    const location_id = Number(body.location_id || 1);
    const qty = Number(body.qty || 1);
    const reference_doc = body.reference_doc || 'PUTAWAY-RFID';

    const prod = memoryStore.products.find((p) => p.id === product_id) || memoryStore.products[0];
    const loc = body.target_location
      ? memoryStore.locations.find((l) => l.rack_name === body.target_location || l.zone_code === body.target_location)
      : memoryStore.locations.find((l) => l.id === location_id);
    const targetRack = body.target_location || loc?.rack_name || 'Rak A1-01';

    if (epc) {
      const existingTag = memoryStore.tags.find((t) => t.epc === epc);
      if (existingTag) {
        existingTag.rack_name = targetRack;
        existingTag.status = 'IN_STOCK';
      }
    }

    const txCode = `TX-${Date.now().toString().slice(-5)}`;
    const newTx = {
      id: memoryStore.stock_movements.length + 1,
      tx_code: txCode,
      movement_type: 'PUTAWAY',
      product_id: prod.id,
      sku: prod.sku,
      product_name: prod.name,
      from_location: 'Zona Transit Inbound',
      to_location: targetRack,
      qty,
      reference_doc,
      operator_name: 'Sarah Jenkins',
      created_at: new Date().toISOString(),
    };
    memoryStore.stock_movements.unshift(newTx);

    const updatedStock = getCalculatedLedgerStock().find((s) => s.product_id === prod.id);
    publishRealtimeEvent('wms/stock/realtime', {
      event: 'PUTAWAY_COMPLETED',
      product: updatedStock,
      ledgerEntry: newTx,
    });

    return reply.code(201).send({
      status: 'ok',
      success: true,
      message: `Tag ${epc || prod.sku} berhasil ditempatkan ke ${targetRack} & dicatat ke Ledger!`,
      ledger: newTx,
      currentStock: updatedStock,
    });
  });
}
