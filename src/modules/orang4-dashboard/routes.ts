import { FastifyInstance } from 'fastify';
import { db, isPostgresConnected, memoryStore, getCalculatedLedgerStock } from '../../config/db';
import { mqttClient, publishRealtimeEvent } from '../../config/mqtt';

/**
 * ============================================================================
 * MODUL ORANG 4: PONDASI SERVER, DASHBOARD KPI UTAMA & MANAJEMEN PENGGUNA
 * ============================================================================
 */
export async function orang4DashboardRoutes(app: FastifyInstance) {
  // 1. GET Status Kesehatan Server, PostgreSQL & Broker EMQX
  app.get('/api/health', async () => {
    return {
      status: 'OK',
      service: 'DIGI WMS Backend API (Tahap 1 Pondasi)',
      database_mode: isPostgresConnected ? 'POSTGRESQL_DOCKER' : 'IN_MEMORY_LEDGER_READY',
      emqx_mqtt: mqttClient?.connected ? 'CONNECTED' : 'STANDBY_SIMULATION',
      timestamp: new Date().toISOString(),
    };
  });

  // 2. GET Metrik KPI Dashboard Utama
  app.get('/api/dashboard/summary', async () => {
    if (isPostgresConnected) {
      const stockRes = await db.query(
        'SELECT COALESCE(SUM(current_stock), 0)::INT AS total_stock FROM v_product_stock_ledger'
      );
      const grnRes = await db.query(
        'SELECT COALESCE(SUM(total_qty), 0)::INT AS total_inbound FROM goods_receipts'
      );
      const tagsRes = await db.query('SELECT COUNT(*)::INT AS active_tags FROM tags');
      const lowStockRes = await db.query(
        "SELECT * FROM v_product_stock_ledger WHERE stock_status = 'STOK_RENDAH'"
      );

      return {
        success: true,
        kpi: {
          total_stock: stockRes.rows[0].total_stock,
          total_inbound: grnRes.rows[0].total_inbound,
          active_rfid_tags: tagsRes.rows[0].active_tags,
          low_stock_items: lowStockRes.rows,
        },
      };
    }

    const ledgerStocks = getCalculatedLedgerStock();
    const total_stock = ledgerStocks.reduce((acc, s) => acc + s.current_stock, 0);
    const total_inbound = memoryStore.goods_receipts.reduce((acc, g) => acc + g.total_qty, 0);
    const active_rfid_tags = memoryStore.tags.length;
    const low_stock_items = ledgerStocks.filter((s) => s.stock_status === 'STOK_RENDAH');

    return {
      success: true,
      kpi: {
        total_stock,
        total_inbound,
        active_rfid_tags,
        low_stock_items,
      },
    };
  });

  // 3. GET Daftar Pengguna (Users)
  app.get('/api/users', async () => {
    if (isPostgresConnected) {
      const res = await db.query(
        'SELECT id, username, full_name, role, is_active, created_at FROM users ORDER BY id ASC'
      );
      return { success: true, data: res.rows };
    }
    return { success: true, data: memoryStore.users };
  });

  // 4. POST Tes Broadcast Pesan Real-time via EMQX MQTT
  app.post('/api/mqtt/test-publish', async (request) => {
    const { topic = 'wms/stock/realtime', message = 'Halo dari Backend DIGI WMS!' } =
      (request.body as { topic?: string; message?: string }) || {};

    publishRealtimeEvent(topic, { testMessage: message });
    return {
      success: true,
      topic,
      emqxConnected: Boolean(mqttClient?.connected),
    };
  });
}
