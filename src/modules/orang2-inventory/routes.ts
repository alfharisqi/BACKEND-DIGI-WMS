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
      return { success: true, data: res.rows };
    }
    return { success: true, data: memoryStore.locations };
  });

  // 2. GET Ringkasan Stok Barang (Dihitung dari View Buku Besar)
  app.get('/api/inventory/stock', async () => {
    if (isPostgresConnected) {
      const res = await db.query('SELECT * FROM v_product_stock_ledger');
      return { success: true, data: res.rows };
    }
    return { success: true, data: getCalculatedLedgerStock() };
  });

  // 3. GET Riwayat Buku Besar Mutasi Stok (Stock Movement Ledger Append-Only)
  app.get('/api/inventory/ledger', async () => {
    if (isPostgresConnected) {
      const res = await db.query(`
        SELECT sm.*, p.sku, p.name AS product_name, u.full_name AS operator_name
        FROM stock_movements sm
        JOIN products p ON sm.product_id = p.id
        LEFT JOIN users u ON sm.operator_id = u.id
        ORDER BY sm.created_at DESC
        LIMIT 100
      `);
      return { success: true, data: res.rows };
    }
    return { success: true, data: memoryStore.stock_movements };
  });

  // 4. POST Proses Putaway (Menempatkan Barang ke Rak & Mencatat ke Ledger)
  app.post('/api/inventory/putaway', async (request, reply) => {
    const { epc, product_id, location_id, qty = 1, reference_doc = 'PUTAWAY-MANUAL' } =
      request.body as {
        epc?: string;
        product_id: number;
        location_id: number;
        qty?: number;
        reference_doc?: string;
      };

    if (isPostgresConnected) {
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        const locRes = await client.query('SELECT * FROM locations WHERE id = $1', [location_id]);
        const targetRack = locRes.rows[0]?.rack_name || 'Rak Gudang';

        if (epc) {
          await client.query(
            `UPDATE tags SET status = 'IN_STOCK', updated_at = NOW() WHERE epc = $1`,
            [epc]
          );
          await client.query(
            `UPDATE items SET location_id = $1, updated_at = NOW()
             WHERE tag_id = (SELECT id FROM tags WHERE epc = $2)`,
            [location_id, epc]
          );
        }

        const txCode = `TX-${Date.now().toString().slice(-6)}`;
        const ledgerRes = await client.query(
          `INSERT INTO stock_movements 
            (tx_code, movement_type, product_id, from_location, to_location, qty, reference_doc, operator_id)
           VALUES ($1, 'PUTAWAY', $2, 'Zona Transit Inbound', $3, $4, $5, 1)
           RETURNING *`,
          [txCode, product_id, targetRack, qty, reference_doc]
        );

        const updatedStock = await client.query(
          'SELECT * FROM v_product_stock_ledger WHERE product_id = $1',
          [product_id]
        );

        await client.query('COMMIT');

        publishRealtimeEvent('wms/stock/realtime', {
          event: 'PUTAWAY_COMPLETED',
          product: updatedStock.rows[0],
          ledgerEntry: ledgerRes.rows[0],
        });

        return reply.code(201).send({
          success: true,
          ledger: ledgerRes.rows[0],
          currentStock: updatedStock.rows[0],
        });
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    }

    // Mode In-Memory Ledger Store
    const prod = memoryStore.products.find((p) => p.id === Number(product_id));
    const loc = memoryStore.locations.find((l) => l.id === Number(location_id));
    const txCode = `TX-${Date.now().toString().slice(-5)}`;
    const newTx = {
      id: memoryStore.stock_movements.length + 1,
      tx_code: txCode,
      movement_type: 'PUTAWAY',
      product_id: Number(product_id),
      sku: prod?.sku || 'SKU-012',
      product_name: prod?.name || 'Produk Gudang',
      from_location: 'Zona Transit Inbound',
      to_location: loc?.rack_name || 'Rak A1-01',
      qty: Number(qty),
      reference_doc,
      operator_name: 'Sarah Jenkins',
      created_at: new Date().toISOString(),
    };
    memoryStore.stock_movements.unshift(newTx);

    const updatedStock = getCalculatedLedgerStock().find((s) => s.product_id === Number(product_id));
    publishRealtimeEvent('wms/stock/realtime', {
      event: 'PUTAWAY_COMPLETED',
      product: updatedStock,
      ledgerEntry: newTx,
    });

    return reply.code(201).send({
      success: true,
      ledger: newTx,
      currentStock: updatedStock,
    });
  });
}
