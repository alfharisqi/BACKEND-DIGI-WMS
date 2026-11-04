import { FastifyInstance } from 'fastify';
import { db, isPostgresConnected, memoryStore, getCalculatedLedgerStock } from '../../config/db';
import { mqttClient, publishRealtimeEvent } from '../../config/mqtt';

/**
 * ============================================================================
 * MODUL LENGKAP ORANG 4:
 * - PONDASI SERVER & HEALTH MONITOR (PostgreSQL + EMQX MQTT)
 * - DASHBOARD KPI EKSEKUTIF, GRAFIK PERGERAKAN STOK & PERINGATAN STOK KRITIS
 * - AUTENTIKASI LOGIN ROLE, MANAJEMEN PENGGUNA (RBAC) & AUDIT LOGS
 * - PENGATURAN SISTEM GUDANG & PARAMETER FREKUENSI UHF RFID (920-923 MHz)
 * ============================================================================
 */
export async function orang4DashboardRoutes(app: FastifyInstance) {
  // 1. GET Status Kesehatan Server, PostgreSQL & Broker EMQX
  app.get('/api/health', async () => {
    return {
      status: 'OK',
      service: 'DIGI WMS Backend API — Modul Orang 4',
      database_mode: isPostgresConnected ? 'POSTGRESQL_DOCKER' : 'IN_MEMORY_LEDGER_READY',
      emqx_mqtt: mqttClient?.connected ? 'CONNECTED' : 'STANDBY_SIMULATION',
      uptime_seconds: Math.floor(process.uptime()),
      rfid_freq: memoryStore.settings.rfid_frequency,
      timestamp: new Date().toISOString(),
    };
  });

  // 2. GET Metrik KPI Dashboard Utama + Grafik Pergerakan + Distribusi Kategori
  app.get('/api/dashboard/summary', async () => {
    let total_stock = 0;
    let total_inbound = 0;
    let active_rfid_tags = 0;
    let low_stock_items: Array<Record<string, unknown>> = [];
    let all_stocks: Array<{ category: string; current_stock: number }> = [];

    if (isPostgresConnected) {
      const stockRes = await db.query('SELECT * FROM v_product_stock_ledger');
      all_stocks = stockRes.rows;
      total_stock = all_stocks.reduce((acc, s) => acc + Number(s.current_stock), 0);

      const grnRes = await db.query(
        'SELECT COALESCE(SUM(total_qty), 0)::INT AS total_inbound FROM goods_receipts'
      );
      total_inbound = grnRes.rows[0].total_inbound;

      const tagsRes = await db.query('SELECT COUNT(*)::INT AS active_tags FROM tags');
      active_rfid_tags = tagsRes.rows[0].active_tags;

      low_stock_items = stockRes.rows.filter((s) => s.stock_status === 'STOK_RENDAH');
    } else {
      const ledgerStocks = getCalculatedLedgerStock();
      all_stocks = ledgerStocks;
      total_stock = ledgerStocks.reduce((acc, s) => acc + s.current_stock, 0);
      total_inbound = memoryStore.goods_receipts.reduce((acc, g) => acc + g.total_qty, 0);
      active_rfid_tags = memoryStore.tags.length;
      low_stock_items = ledgerStocks.filter((s) => s.stock_status === 'STOK_RENDAH');
    }

    // Hitung distribusi stok per kategori untuk chart Orang 4
    const categoryMap: Record<string, number> = {};
    all_stocks.forEach((item) => {
      categoryMap[item.category] = (categoryMap[item.category] || 0) + Number(item.current_stock);
    });
    const category_distribution = Object.entries(categoryMap).map(([category, stock]) => ({
      category,
      stock,
    }));

    return {
      success: true,
      kpi: {
        total_stock,
        total_inbound,
        active_rfid_tags,
        total_Zones: memoryStore.locations.length,
        low_stock_items,
        category_distribution,
        chart_7d: [
          { label: '6 Mei', inbound: 45, putaway: 40, total: 190 },
          { label: '7 Mei', inbound: 60, putaway: 55, total: 215 },
          { label: '8 Mei', inbound: 30, putaway: 35, total: 230 },
          { label: '9 Mei', inbound: 85, putaway: 75, total: 255 },
          { label: '10 Mei', inbound: 50, putaway: 48, total: 268 },
          { label: '11 Mei', inbound: 70, putaway: 65, total: 275 },
          { label: 'Hari Ini', inbound: 95, putaway: 90, total: total_stock },
        ],
        chart_30d: [
          { label: 'Minggu 1', inbound: 210, putaway: 195, total: 180 },
          { label: 'Minggu 2', inbound: 320, putaway: 300, total: 225 },
          { label: 'Minggu 3', inbound: 280, putaway: 270, total: 260 },
          { label: 'Minggu 4', inbound: 390, putaway: 375, total: total_stock },
        ],
      },
    };
  });

  // 3. POST Login / Switch Role Pengguna Aktif + Catat ke Audit Log
  app.post('/api/auth/login', async (request, reply) => {
    const { username } = request.body as { username: string; password?: string };

    if (isPostgresConnected) {
      const res = await db.query(
        'SELECT id, username, full_name, role, is_active FROM users WHERE username = $1',
        [username]
      );
      if (res.rows.length === 0) {
        return reply.code(404).send({ success: false, message: 'Pengguna tidak ditemukan' });
      }
      const user = res.rows[0];
      await db.query('INSERT INTO audit_logs (user_id, action, payload) VALUES ($1, $2, $3)', [
        user.id,
        'USER_LOGIN_SWITCH',
        JSON.stringify({ username: user.username, role: user.role }),
      ]);
      return {
        success: true,
        token: `jwt-digiwms-${user.id}-${Date.now()}`,
        user,
      };
    }

    const user = memoryStore.users.find((u) => u.username === username);
    if (!user) {
      return reply.code(404).send({ success: false, message: 'Pengguna tidak ditemukan' });
    }

    memoryStore.audit_logs.unshift({
      id: memoryStore.audit_logs.length + 1,
      user_id: user.id,
      user_name: user.full_name,
      action: 'USER_LOGIN_SWITCH',
      payload: { username: user.username, role: user.role },
      created_at: new Date().toISOString(),
    });

    return {
      success: true,
      token: `jwt-digiwms-${user.id}-${Date.now()}`,
      user,
    };
  });

  // 4. GET Daftar Pengguna (Users)
  app.get('/api/users', async () => {
    if (isPostgresConnected) {
      const res = await db.query(
        'SELECT id, username, full_name, role, is_active, created_at FROM users ORDER BY id ASC'
      );
      return { success: true, data: res.rows };
    }
    return { success: true, data: memoryStore.users };
  });

  // 5. POST Tambah Pengguna Baru (Manajemen Staf Gudang oleh Orang 4)
  app.post('/api/users', async (request, reply) => {
    const { username, full_name, role = 'WAREHOUSE_STAFF' } = request.body as {
      username: string;
      full_name: string;
      role?: string;
    };

    if (isPostgresConnected) {
      const res = await db.query(
        `INSERT INTO users (username, password_hash, full_name, role, is_active)
         VALUES ($1, '$2b$10$defaultpasswordhash', $2, $3, TRUE)
         RETURNING id, username, full_name, role, is_active, created_at`,
        [username, full_name, role]
      );
      await db.query('INSERT INTO audit_logs (user_id, action, payload) VALUES (1, $1, $2)', [
        'CREATE_USER',
        JSON.stringify({ username, full_name, role }),
      ]);
      return reply.code(201).send({ success: true, data: res.rows[0] });
    }

    const newUser = {
      id: memoryStore.users.length + 1,
      username,
      full_name,
      role,
      is_active: true,
      created_at: new Date().toISOString(),
    };
    memoryStore.users.push(newUser);
    memoryStore.audit_logs.unshift({
      id: memoryStore.audit_logs.length + 1,
      user_id: 1,
      user_name: 'Admin / Supervisor',
      action: 'CREATE_USER',
      payload: { username, full_name, role },
      created_at: new Date().toISOString(),
    });

    return reply.code(201).send({ success: true, data: newUser });
  });

  // 6. PATCH Aktifkan / Nonaktifkan Status Pengguna
  app.patch('/api/users/:id/toggle', async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = Number(id);

    if (isPostgresConnected) {
      const res = await db.query(
        `UPDATE users SET is_active = NOT is_active WHERE id = $1
         RETURNING id, username, full_name, role, is_active, created_at`,
        [userId]
      );
      return reply.send({ success: true, data: res.rows[0] });
    }

    const target = memoryStore.users.find((u) => u.id === userId);
    if (target) {
      target.is_active = !target.is_active;
      memoryStore.audit_logs.unshift({
        id: memoryStore.audit_logs.length + 1,
        user_id: 1,
        user_name: 'Admin / Supervisor',
        action: 'TOGGLE_USER_STATUS',
        payload: { username: target.username, is_active: target.is_active },
        created_at: new Date().toISOString(),
      });
    }
    return reply.send({ success: true, data: target });
  });

  // 7. GET Riwayat Audit Log Keamanan Sistem
  app.get('/api/audit-logs', async () => {
    if (isPostgresConnected) {
      const res = await db.query(`
        SELECT a.*, COALESCE(u.full_name, 'System Admin') AS user_name
        FROM audit_logs a
        LEFT JOIN users u ON a.user_id = u.id
        ORDER BY a.created_at DESC
        LIMIT 50
      `);
      return { success: true, data: res.rows };
    }
    return { success: true, data: memoryStore.audit_logs };
  });

  // 8. GET & PUT Pengaturan Sistem Gudang & Parameter RFID
  app.get('/api/settings', async () => {
    return { success: true, data: memoryStore.settings };
  });

  app.put('/api/settings', async (request) => {
    const body = request.body as Partial<typeof memoryStore.settings>;
    memoryStore.settings = {
      ...memoryStore.settings,
      ...body,
      updated_at: new Date().toISOString(),
    };

    memoryStore.audit_logs.unshift({
      id: memoryStore.audit_logs.length + 1,
      user_id: 1,
      user_name: 'Sarah Jenkins',
      action: 'UPDATE_SYSTEM_SETTINGS',
      payload: body as Record<string, unknown>,
      created_at: new Date().toISOString(),
    });

    publishRealtimeEvent('wms/stock/realtime', {
      event: 'SYSTEM_SETTINGS_UPDATED',
      settings: memoryStore.settings,
    });

    return { success: true, data: memoryStore.settings };
  });

  // 9. POST Tes Broadcast Pesan Real-time via EMQX MQTT
  app.post('/api/mqtt/test-publish', async (request) => {
    const { topic = 'wms/stock/realtime', message = 'Ping Real-time dari Dashboard Orang 4!' } =
      (request.body as { topic?: string; message?: string }) || {};

    publishRealtimeEvent(topic, {
      event: 'MANUAL_BROADCAST_ORANG4',
      testMessage: message,
      sender: 'Modul Orang 4 (Dashboard & Server)',
    });

    memoryStore.audit_logs.unshift({
      id: memoryStore.audit_logs.length + 1,
      user_id: 1,
      user_name: 'Sarah Jenkins',
      action: 'MQTT_TEST_BROADCAST',
      payload: { topic, message },
      created_at: new Date().toISOString(),
    });

    return {
      success: true,
      topic,
      message,
      emqxConnected: Boolean(mqttClient?.connected),
    };
  });
}
