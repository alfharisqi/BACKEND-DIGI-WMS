import { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { db, isPostgresConnected, memoryStore, getCalculatedLedgerStock } from '../../config/db';
import { mqttClient, publishRealtimeEvent } from '../../config/mqtt';
import { generateToken, authenticate, requireRoles } from '../../middleware/auth';

/**
 * ============================================================================
 * MODUL LENGKAP ORANG 4:
 * - PONDASI SERVER & HEALTH MONITOR (PostgreSQL + EMQX MQTT)
 * - DASHBOARD KPI EKSEKUTIF, GRAFIK PERGERAKAN STOK & PERINGATAN STOK KRITIS
 * - AUTENTIKASI LOGIN RESMI (USERNAME & PASSWORD), MANAJEMEN USER (CRUD RBAC) & AUDIT LOGS
 * - PENGATURAN SISTEM GUDANG & PARAMETER FREKUENSI UHF RFID (920-923 MHz)
 * ============================================================================
 */
export async function orang4DashboardRoutes(app: FastifyInstance) {
  // 1. GET Status Kesehatan Server, PostgreSQL & Broker EMQX
  app.get('/api/health', async () => {
    const ledgerStocks = getCalculatedLedgerStock();
    return {
      status: 'OK',
      service: 'DIGI WMS Backend API — Modul Orang 4',
      database_mode: isPostgresConnected
        ? process.env.DATABASE_URL?.includes('supabase')
          ? 'SUPABASE_CLOUD_POSTGRES (Port 6543/5432)'
          : 'POSTGRESQL_16_DOCKER (Port 5432)'
        : 'IN_MEMORY_LEDGER_READY (Auto Fallback)',
      emqx_mqtt: mqttClient?.connected
        ? 'CONNECTED (TCP 1883 / WS 8083)'
        : 'STANDBY_SIMULATION (Siap Konek EMQX)',
      uptime_seconds: Math.floor(process.uptime()),
      rfid_freq: memoryStore.settings.rfid_frequency || '920 - 923 MHz (Indonesia)',
      stats: {
        total_users: memoryStore.users.length,
        total_skus: ledgerStocks.length,
        total_tags: memoryStore.tags.length,
        total_audit_logs: memoryStore.audit_logs.length,
      },
      timestamp: new Date().toISOString(),
    };
  });

  // 2. GET Metrik KPI Dashboard Utama + Grafik Pergerakan + Distribusi Kategori
  app.get('/api/dashboard/summary', async () => {
    let total_stock = 0;
    let total_inbound = 0;
    let active_rfid_tags = 0;
    let active_gate_passes = 0;
    let gate_alarms_count = 0;
    let total_zones = memoryStore.locations.length;
    let low_stock_items: Array<Record<string, unknown>> = [];
    let all_stocks: Array<{ category: string; current_stock: number }> = [];

    let days7: Array<{ label: string; inbound: number; outbound: number; opname: number }> = [];
    let days30: Array<{ label: string; inbound: number; outbound: number; opname: number }> = [];

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

      const gpRes = await db.query(
        "SELECT COUNT(*)::INT AS active_gp FROM gate_passes WHERE status = 'ACTIVE'"
      );
      active_gate_passes = gpRes.rows[0]?.active_gp || 0;

      const alarmRes = await db.query(
        "SELECT COUNT(*)::INT AS active_alarms FROM alarms WHERE status = 'ACTIVE'"
      );
      gate_alarms_count = alarmRes.rows[0]?.active_alarms || 0;

      const locRes = await db.query('SELECT COUNT(*)::INT AS total_loc FROM locations');
      total_zones = locRes.rows[0]?.total_loc || total_zones;

      low_stock_items = stockRes.rows.filter((s) => s.stock_status === 'STOK_RENDAH');

      // Agregasi Tren 7 Hari Terakhir langsung dari tabel stock_movements
      const d7Res = await db.query(`
        WITH dates AS (
          SELECT generate_series(CURRENT_DATE - INTERVAL '6 days', CURRENT_DATE, '1 day')::date AS dt
        )
        SELECT
          TO_CHAR(d.dt, 'DD Mon') AS label,
          (d.dt = CURRENT_DATE) AS is_today,
          COALESCE(SUM(CASE WHEN sm.qty_change > 0 AND sm.movement_type NOT ILIKE '%OPNAME%' THEN sm.qty_change ELSE 0 END), 0)::INT AS inbound,
          COALESCE(SUM(CASE WHEN sm.qty_change < 0 AND sm.movement_type NOT ILIKE '%OPNAME%' THEN ABS(sm.qty_change) ELSE 0 END), 0)::INT AS outbound,
          COALESCE(SUM(CASE WHEN sm.movement_type ILIKE '%OPNAME%' THEN ABS(sm.qty_change) ELSE 0 END), 0)::INT AS opname
        FROM dates d
        LEFT JOIN stock_movements sm ON DATE(sm.created_at AT TIME ZONE 'Asia/Jakarta') = d.dt
        GROUP BY d.dt
        ORDER BY d.dt ASC
      `);
      days7 = d7Res.rows.map((r) => ({
        label: r.is_today ? 'Hari Ini' : r.label,
        inbound: Number(r.inbound) || 0,
        outbound: Number(r.outbound) || 0,
        opname: Number(r.opname) || 0,
      }));

      // Agregasi Tren 30 Hari (4 Minggu Terakhir) langsung dari tabel stock_movements
      const d30Res = await db.query(`
        WITH weeks AS (
          SELECT generate_series(0, 3) AS w_idx
        )
        SELECT
          'Minggu ' || (4 - w.w_idx) AS label,
          w.w_idx,
          COALESCE(SUM(CASE WHEN sm.qty_change > 0 AND sm.movement_type NOT ILIKE '%OPNAME%' THEN sm.qty_change ELSE 0 END), 0)::INT AS inbound,
          COALESCE(SUM(CASE WHEN sm.qty_change < 0 AND sm.movement_type NOT ILIKE '%OPNAME%' THEN ABS(sm.qty_change) ELSE 0 END), 0)::INT AS outbound,
          COALESCE(SUM(CASE WHEN sm.movement_type ILIKE '%OPNAME%' THEN ABS(sm.qty_change) ELSE 0 END), 0)::INT AS opname
        FROM weeks w
        LEFT JOIN stock_movements sm
          ON sm.created_at >= (CURRENT_DATE - ((w.w_idx + 1) * 7 - 1) * INTERVAL '1 day')
         AND sm.created_at < (CURRENT_DATE - (w.w_idx * 7) * INTERVAL '1 day' + INTERVAL '1 day')
        GROUP BY w.w_idx
        ORDER BY w.w_idx DESC
      `);
      days30 = d30Res.rows.map((r) => ({
        label: r.label,
        inbound: Number(r.inbound) || 0,
        outbound: Number(r.outbound) || 0,
        opname: Number(r.opname) || 0,
      }));
    } else {
      const ledgerStocks = getCalculatedLedgerStock();
      all_stocks = ledgerStocks;
      total_stock = ledgerStocks.reduce((acc, s) => acc + s.current_stock, 0);
      total_inbound = memoryStore.goods_receipts.reduce((acc, g) => acc + g.total_qty, 0);
      active_rfid_tags = memoryStore.tags.length;
      active_gate_passes = ((memoryStore.gate_passes as Array<Record<string, unknown>>) || []).filter(
        (g) => g.status === 'ACTIVE'
      ).length;
      gate_alarms_count = ((memoryStore.alarms as Array<Record<string, unknown>>) || []).filter(
        (a) => a.status === 'ACTIVE'
      ).length;
      low_stock_items = ledgerStocks.filter((s) => s.stock_status === 'STOK_RENDAH');

      days7 = [
        { label: 'Hari -6', inbound: 0, outbound: 0, opname: 0 },
        { label: 'Hari -5', inbound: 0, outbound: 0, opname: 0 },
        { label: 'Hari -4', inbound: 0, outbound: 0, opname: 0 },
        { label: 'Hari -3', inbound: 0, outbound: 0, opname: 0 },
        { label: 'Hari -2', inbound: 0, outbound: 0, opname: 0 },
        { label: 'Kemarin', inbound: 0, outbound: 0, opname: 0 },
        { label: 'Hari Ini', inbound: total_inbound, outbound: 0, opname: 0 },
      ];
      days30 = [
        { label: 'Minggu 1', inbound: 0, outbound: 0, opname: 0 },
        { label: 'Minggu 2', inbound: 0, outbound: 0, opname: 0 },
        { label: 'Minggu 3', inbound: 0, outbound: 0, opname: 0 },
        { label: 'Minggu 4', inbound: total_inbound, outbound: 0, opname: 0 },
      ];
    }

    const categoryMap: Record<string, number> = {};
    all_stocks.forEach((item) => {
      categoryMap[item.category] = (categoryMap[item.category] || 0) + Number(item.current_stock);
    });
    const category_distribution = Object.entries(categoryMap).map(([category, stock]) => ({
      category,
      stock,
    }));

    const summaryData = {
      kpis: {
        totalSkus: all_stocks.length,
        totalPhysicalStock: total_stock,
        activeRfidTags: active_rfid_tags,
        gateAlarmsCount: gate_alarms_count,
        totalInbound: total_inbound,
        activeGatePasses: active_gate_passes,
      },
      chartData: {
        days7,
        days30,
      },
      categoryDistribution: category_distribution,
      lowStockItems: low_stock_items,
    };

    return {
      status: 'ok',
      success: true,
      data: summaryData,
      kpi: {
        total_stock,
        total_inbound,
        active_rfid_tags,
        active_gate_passes,
        gate_alarms_count,
        total_Zones: total_zones,
        low_stock_items,
        category_distribution,
      },
    };
  });

  // 3. POST Login Resmi (Validasi Username & Password Hash + Catat ke Audit Log)
  app.post('/api/auth/login', async (request, reply) => {
    const { username, password } = request.body as { username: string; password?: string };

    if (!username || !password) {
      return reply
        .code(400)
        .send({ success: false, message: 'Username dan password wajib diisi!' });
    }

    if (isPostgresConnected) {
      const res = await db.query(
        'SELECT id, username, password_hash, full_name, role, is_active FROM users WHERE LOWER(username) = LOWER($1) OR LOWER(email) = LOWER($1)',
        [username.trim()]
      );
      if (res.rows.length === 0) {
        return reply
          .code(401)
          .send({ success: false, message: 'Username atau password salah!' });
      }
      const user = res.rows[0];
      if (!user.is_active) {
        return reply
          .code(403)
          .send({ success: false, message: 'Akun personel ini sedang dinonaktifkan oleh Admin!' });
      }

      // Verifikasi kata sandi ter-hash dengan bcrypt
      const isMatch = await bcrypt.compare(password, user.password_hash || '');
      if (!isMatch) {
        return reply
          .code(401)
          .send({ success: false, message: 'Username atau password salah!' });
      }

      await db.query('INSERT INTO audit_logs (user_id, action, payload) VALUES ($1, $2, $3)', [
        user.id,
        'USER_LOGIN',
        JSON.stringify({
          username: user.username,
          role: user.role,
          note: `Login berhasil ke sistem DIGI WMS (${user.role}) - Verified with bcrypt`,
        }),
      ]);

      const { password_hash: _ph, ...safeUser } = user;
      const token = generateToken(safeUser);
      return {
        status: 'ok',
        success: true,
        message: `Selamat datang, ${user.full_name} (${user.role})`,
        token,
        user: safeUser,
        data: { user: safeUser, token },
      };
    }

    const user = memoryStore.users.find(
      (u) => u.username.toLowerCase() === String(username || '').trim().toLowerCase()
    );
    if (!user) {
      return reply
        .code(401)
        .send({ success: false, message: 'Username atau password salah!' });
    }
    if (!user.is_active) {
      return reply
        .code(403)
        .send({ success: false, message: 'Akun personel ini sedang dinonaktifkan oleh Admin!' });
    }

    const isMatch = await bcrypt.compare(password, user.password_hash || '');
    if (!isMatch) {
      return reply
        .code(401)
        .send({ success: false, message: 'Username atau password salah!' });
    }

    memoryStore.audit_logs.unshift({
      id: memoryStore.audit_logs.length + 1,
      user_id: user.id,
      user_name: user.full_name,
      action: 'USER_LOGIN',
      payload: {
        username: user.username,
        role: user.role,
        note: `Login berhasil ke portal DIGI WMS (${user.role}) - Verified with bcrypt`,
      },
      created_at: new Date().toISOString(),
    });

    publishRealtimeEvent('digiwms/audit/login', {
      username: user.username,
      full_name: user.full_name,
      role: user.role,
    });

    const { password_hash: _ph, ...safeUser } = user;
    const token = generateToken(safeUser);
    return {
      status: 'ok',
      success: true,
      message: `Selamat datang, ${user.full_name} (${user.role})`,
      token,
      user: safeUser,
      data: { user: safeUser, token },
    };
  });

  // 3B. POST Logout Pengguna
  app.post('/api/auth/logout', async (request) => {
    const { username, full_name, role } =
      (request.body as { username?: string; full_name?: string; role?: string }) || {};
    memoryStore.audit_logs.unshift({
      id: memoryStore.audit_logs.length + 1,
      user_id: 1,
      user_name: full_name || username || 'User',
      action: 'USER_LOGOUT',
      payload: {
        username: username || 'unknown',
        role: role || 'STAFF',
        note: `Logout keluar dari sesi DIGI WMS`,
      },
      created_at: new Date().toISOString(),
    });
    return { status: 'ok', success: true, message: 'Berhasil keluar dari sesi' };
  });

  // 3C. GET Identitas Pengguna dari JWT (Contoh Penggunaan request.user.id)
  app.get('/api/auth/me', { preHandler: [authenticate] }, async (request) => {
    // Backend mengambil identitas pengguna langsung dari token JWT yang sudah diverifikasi:
    const userId = request.user?.id;
    const username = request.user?.username;
    const role = request.user?.role;
    const fullName = request.user?.full_name;

    return {
      status: 'ok',
      success: true,
      message: 'Identitas pengguna berhasil diekstrak dari JWT token',
      user: request.user,
      extracted_info: {
        user_id: userId,
        username,
        role,
        full_name: fullName,
      },
    };
  });

  // 4. GET Daftar Pengguna (Users)
  app.get('/api/users', async () => {
    if (isPostgresConnected) {
      const res = await db.query(
        'SELECT id, username, email, full_name, role, is_active, created_at FROM users ORDER BY created_at ASC'
      );
      return { status: 'ok', success: true, data: res.rows };
    }
    const safeUsers = memoryStore.users.map(({ password_hash: _p, ...rest }) => rest);
    return { status: 'ok', success: true, data: safeUsers };
  });

  // 5. POST Tambah Pengguna Baru (Manajemen Staf Gudang oleh Orang 4)
  app.post('/api/users', async (request, reply) => {
    const {
      username,
      password = '123456',
      full_name,
      role = 'WAREHOUSE_STAFF',
    } = request.body as {
      username: string;
      password?: string;
      full_name: string;
      role?: string;
    };

    if (!username || !full_name) {
      return reply.code(400).send({
        status: 'error',
        success: false,
        message: 'Username dan Nama Lengkap wajib diisi!',
      });
    }

    // Hash kata sandi menggunakan bcrypt (10 rounds salt)
    const passwordHash = await bcrypt.hash(password || '123456', 10);

    if (isPostgresConnected) {
      const check = await db.query(
        'SELECT id FROM users WHERE LOWER(username) = LOWER($1) OR LOWER(email) = LOWER($2)',
        [username.trim(), `${username.trim()}@digiwms.id`]
      );
      if (check.rows.length > 0) {
        return reply.code(400).send({
          status: 'error',
          success: false,
          message: `Username @${username} sudah terdaftar di sistem!`,
        });
      }

      const res = await db.query(
        `INSERT INTO users (username, email, password_hash, full_name, role, is_active)
         VALUES ($1, $2, $3, $4, $5, TRUE)
         RETURNING id, username, full_name, role, is_active, created_at`,
        [username.trim(), `${username.trim()}@digiwms.id`, passwordHash, full_name.trim(), role]
      );
      await db.query('INSERT INTO audit_logs (user_id, action, payload) VALUES ($1, $2, $3)', [
        res.rows[0].id,
        'CREATE_USER',
        JSON.stringify({ username: username.trim(), full_name: full_name.trim(), role, note: 'User dibuat dengan bcrypt password hash' }),
      ]);
      return reply.code(201).send({
        status: 'ok',
        success: true,
        message: `Personel ${full_name} (${role}) berhasil didaftarkan (Password telah di-hash)`,
        data: res.rows[0],
      });
    }

    if (memoryStore.users.some((u) => u.username.toLowerCase() === username.toLowerCase())) {
      return reply.code(400).send({
        status: 'error',
        success: false,
        message: `Username @${username} sudah terdaftar!`,
      });
    }

    const newUser = {
      id: memoryStore.users.length > 0 ? Math.max(...memoryStore.users.map((u) => u.id)) + 1 : 1,
      username: username.trim(),
      password_hash: passwordHash,
      full_name: full_name.trim(),
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
      payload: {
        username: username.trim(),
        full_name: full_name.trim(),
        role,
        note: `Mendaftarkan personel baru: ${full_name} (@${username}) sebagai ${role} (Password di-hash)`,
      },
      created_at: new Date().toISOString(),
    });

    const { password_hash: _pw, ...safeNewUser } = newUser;
    return reply.code(201).send({
      status: 'ok',
      success: true,
      message: `Personel ${full_name} (${role}) berhasil didaftarkan (Password telah di-hash)`,
      data: safeNewUser,
    });
  });

  // 5B. PUT Edit Data Pengguna & Reset Password (Password Otomatis Di-hash)
  app.put('/api/users/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { full_name, role, password } = request.body as {
      full_name?: string;
      role?: string;
      password?: string;
    };

    let passwordHash: string | undefined;
    if (password && password.trim().length > 0) {
      passwordHash = await bcrypt.hash(password.trim(), 10);
    }

    if (isPostgresConnected) {
      const updates: string[] = ['updated_at = NOW()'];
      const values: any[] = [];
      let idx = 1;

      if (full_name) {
        updates.push(`full_name = $${idx++}`);
        values.push(full_name.trim());
      }
      if (role) {
        updates.push(`role = $${idx++}`);
        values.push(role);
      }
      if (passwordHash) {
        updates.push(`password_hash = $${idx++}`);
        values.push(passwordHash);
      }

      values.push(id);
      const query = `UPDATE users SET ${updates.join(', ')} WHERE id::text = $${idx} RETURNING id, username, full_name, role, is_active, created_at`;
      const res = await db.query(query, values);

      if (res.rows.length === 0) {
        return reply.code(404).send({ status: 'error', message: 'User tidak ditemukan' });
      }

      await db.query('INSERT INTO audit_logs (user_id, action, payload) VALUES ($1, $2, $3)', [
        res.rows[0].id,
        'UPDATE_USER',
        JSON.stringify({
          username: res.rows[0].username,
          role: res.rows[0].role,
          password_reset: !!passwordHash,
          note: `Memperbarui profil/hak akses @${res.rows[0].username}${passwordHash ? ' (Password berhasil di-hash)' : ''}`,
        }),
      ]);

      return reply.send({
        status: 'ok',
        success: true,
        message: `Data personel ${res.rows[0].full_name} berhasil diperbarui${passwordHash ? ' (Password berhasil di-hash & di-reset)' : ''}`,
        data: res.rows[0],
      });
    }

    const userId = Number(id);
    const target = memoryStore.users.find((u) => u.id === userId);
    if (!target) {
      return reply.code(404).send({ status: 'error', message: 'User tidak ditemukan' });
    }

    if (full_name) target.full_name = full_name;
    if (role) target.role = role;
    if (passwordHash) target.password_hash = passwordHash;

    memoryStore.audit_logs.unshift({
      id: memoryStore.audit_logs.length + 1,
      user_id: 1,
      user_name: 'Admin / Supervisor',
      action: 'UPDATE_USER',
      payload: {
        username: target.username,
        role: target.role,
        note: `Memperbarui profil/hak akses @${target.username} (${target.full_name} - ${target.role})`,
      },
      created_at: new Date().toISOString(),
    });

    const { password_hash: _pw, ...safeUser } = target;
    return reply.send({
      status: 'ok',
      success: true,
      message: `Data personel ${target.full_name} berhasil diperbarui`,
      data: safeUser,
    });
  });

  // 6. PATCH Aktifkan / Nonaktifkan Status Pengguna
  app.patch('/api/users/:id/toggle', async (request, reply) => {
    const { id } = request.params as { id: string };

    if (isPostgresConnected) {
      const res = await db.query(
        `UPDATE users SET is_active = NOT is_active WHERE id::text = $1
         RETURNING id, username, full_name, role, is_active, created_at`,
        [id]
      );
      if (res.rows.length === 0) {
        return reply.code(404).send({ status: 'error', message: 'User tidak ditemukan' });
      }

      await db.query('INSERT INTO audit_logs (user_id, action, payload) VALUES ($1, $2, $3)', [
        res.rows[0].id,
        'TOGGLE_USER_STATUS',
        JSON.stringify({
          username: res.rows[0].username,
          is_active: res.rows[0].is_active,
          note: `Status akun @${res.rows[0].username} diubah menjadi ${res.rows[0].is_active ? 'AKTIF' : 'NONAKTIF'}`,
        }),
      ]);

      return reply.send({ status: 'ok', success: true, data: res.rows[0] });
    }

    const userId = Number(id);
    const target = memoryStore.users.find((u) => u.id === userId);
    if (target) {
      target.is_active = !target.is_active;
      memoryStore.audit_logs.unshift({
        id: memoryStore.audit_logs.length + 1,
        user_id: 1,
        user_name: 'Admin / Supervisor',
        action: 'TOGGLE_USER_STATUS',
        payload: {
          username: target.username,
          role: target.role,
          is_active: target.is_active,
          note: `Status akun @${target.username} diubah menjadi ${
            target.is_active ? 'AKTIF' : 'NONAKTIF'
          }`,
        },
        created_at: new Date().toISOString(),
      });
    }
    return reply.send({ status: 'ok', success: true, data: target });
  });

  // 6B. DELETE Hapus Pengguna
  app.delete('/api/users/:id', async (request, reply) => {
    const { id } = request.params as { id: string };

    if (isPostgresConnected) {
      const res = await db.query(
        `DELETE FROM users WHERE id::text = $1 RETURNING id, username, full_name`,
        [id]
      );
      if (res.rows.length === 0) {
        return reply.code(404).send({ status: 'error', message: 'User tidak ditemukan' });
      }

      await db.query('INSERT INTO audit_logs (action, payload) VALUES ($1, $2)', [
        'DELETE_USER',
        JSON.stringify({
          deleted_username: res.rows[0].username,
          note: `Menghapus akun personel @${res.rows[0].username} (${res.rows[0].full_name})`,
        }),
      ]);

      return reply.send({
        status: 'ok',
        success: true,
        message: `Akun @${res.rows[0].username} berhasil dihapus`,
        data: res.rows[0],
      });
    }

    const userId = Number(id);
    const idx = memoryStore.users.findIndex((u) => u.id === userId);
    if (idx === -1) {
      return reply.code(404).send({ status: 'error', message: 'User tidak ditemukan' });
    }

    const removed = memoryStore.users[idx];
    memoryStore.users.splice(idx, 1);

    memoryStore.audit_logs.unshift({
      id: memoryStore.audit_logs.length + 1,
      user_id: 1,
      user_name: 'Admin / Supervisor',
      action: 'DELETE_USER',
      payload: {
        username: removed.username,
        role: removed.role,
        note: `Menghapus akun personel @${removed.username} (${removed.full_name})`,
      },
      created_at: new Date().toISOString(),
    });

    return reply.send({
      status: 'ok',
      success: true,
      message: `Akun @${removed.username} berhasil dihapus`,
    });
  });

  // 7. GET Riwayat Audit Log Keamanan Sistem
  app.get('/api/audit-logs', async (request) => {
    const { role } = (request.query as { role?: string }) || {};
    let rawLogs: Array<Record<string, unknown>> = [];

    if (isPostgresConnected) {
      const res = await db.query(`
        SELECT a.*, COALESCE(u.full_name, 'System Admin') AS user_name, COALESCE(u.role, 'ADMIN') AS user_role
        FROM audit_logs a
        LEFT JOIN users u ON a.user_id = u.id
        ORDER BY a.created_at DESC
        LIMIT 50
      `);
      rawLogs = res.rows;
    } else {
      rawLogs = memoryStore.audit_logs as unknown as Array<Record<string, unknown>>;
    }

    const normalized = rawLogs.map((log) => {
      const payloadObj =
        typeof log.payload === 'object' && log.payload !== null
          ? (log.payload as Record<string, unknown>)
          : {};
      const actorRole = String(payloadObj.role || log.user_role || 'ADMIN');
      const actorUsername = String(log.user_name || payloadObj.username || 'admin_wms');
      const details = String(payloadObj.note || JSON.stringify(payloadObj));
      return {
        id: log.id,
        actor_username: actorUsername,
        actor_role: actorRole,
        action: log.action,
        details,
        created_at: log.created_at,
      };
    });

    const filtered =
      role && role !== 'ALL'
        ? normalized.filter((l) => l.actor_role.toUpperCase().includes(role.toUpperCase()))
        : normalized;

    return { status: 'ok', success: true, data: filtered };
  });

  // 8. GET & PUT Pengaturan Sistem Gudang & Parameter RFID
  app.get('/api/settings', async () => {
    const s = memoryStore.settings as Record<string, unknown>;
    const enriched = {
      ...s,
      warehouse_name: s.warehouse_name || 'Gudang Utama Jakarta Pusat',
      rfid_frequency: s.rfid_frequency || '920 - 923 MHz (Indonesia)',
      rfid_gate_power_dbm: s.rfid_gate_power_dbm ?? 29,
      anti_collision_mode:
        s.anti_collision_mode || 'Dense Reader Mode (M=4) - EPCglobal Gen2',
      alarm_siren_enabled: s.alarm_siren_enabled ?? true,
    };
    return { status: 'ok', success: true, data: enriched };
  });

  app.put('/api/settings', async (request) => {
    const body = request.body as Record<string, unknown>;
    memoryStore.settings = {
      ...memoryStore.settings,
      ...body,
      updated_at: new Date().toISOString(),
    };

    memoryStore.audit_logs.unshift({
      id: memoryStore.audit_logs.length + 1,
      user_id: 1,
      user_name: String(body.updated_by || 'Sarah Jenkins'),
      action: 'UPDATE_SYSTEM_SETTINGS',
      payload: {
        role: 'ADMIN',
        note: `Memperbarui pengaturan gudang (${memoryStore.settings.warehouse_name}) & daya antena RFID`,
      },
      created_at: new Date().toISOString(),
    });

    publishRealtimeEvent('digiwms/settings/updated', {
      event: 'SYSTEM_SETTINGS_UPDATED',
      settings: memoryStore.settings,
    });

    return { status: 'ok', success: true, data: memoryStore.settings };
  });

  // 9. POST Tes Broadcast Pesan Real-time via EMQX MQTT
  app.post('/api/mqtt/test-publish', async (request) => {
    const body = (request.body as Record<string, unknown>) || {};
    const topic = String(body.topic || 'digiwms/rfid/gate-alarm');
    const payload = (body.payload as Record<string, unknown>) || {
      message: String(body.message || 'Ping Real-time dari Dashboard Orang 4!'),
    };

    publishRealtimeEvent(topic, {
      event: 'MANUAL_BROADCAST_ORANG4',
      ...payload,
      sender: 'Modul Orang 4 (Dashboard & Server)',
    });

    memoryStore.audit_logs.unshift({
      id: memoryStore.audit_logs.length + 1,
      user_id: 1,
      user_name: String(payload.operator || 'Sarah Jenkins'),
      action: 'MQTT_TEST_BROADCAST',
      payload: {
        role: 'SUPERVISOR',
        note: `Broadcast paket uji MQTT ke topik ${topic}`,
      },
      created_at: new Date().toISOString(),
    });

    return {
      status: 'ok',
      success: true,
      topic,
      payload,
      emqxConnected: Boolean(mqttClient?.connected),
    };
  });

  // ============================================================================
  // MODUL ORANG 4 (FASE 2): GATE PASS SECURITY ENGINE & OUTBOUND VERIFICATION
  // ============================================================================

  // 10. GET Daftar Gate Pass (MVP 2 - Orang 4)
  app.get('/api/gate-passes', async (request) => {
    const query = (request.query as Record<string, string>) || {};
    const statusFilter = query.status?.toUpperCase();
    const search = query.search?.toLowerCase();

    if (isPostgresConnected) {
      try {
        let sql = `
          SELECT 
            gp.id,
            gp.pass_code,
            gp.sale_id,
            gp.reference_resi,
            gp.authorized_by,
            u.full_name AS authorized_by_name,
            gp.status,
            gp.valid_until,
            gp.used_at,
            gp.created_at,
            s.order_type,
            s.customer_or_destination,
            s.courier,
            s.total_items,
            s.total_amount
          FROM gate_passes gp
          LEFT JOIN sales s ON gp.sale_id = s.id
          LEFT JOIN users u ON gp.authorized_by = u.id
          WHERE 1=1
        `;
        const params: unknown[] = [];

        if (statusFilter && ['ACTIVE', 'USED', 'EXPIRED', 'REVOKED', 'CANCELLED'].includes(statusFilter)) {
          params.push(statusFilter);
          sql += ` AND gp.status = $${params.length}`;
        }

        if (search) {
          params.push(`%${search}%`);
          sql += ` AND (LOWER(gp.pass_code) LIKE $${params.length} OR LOWER(COALESCE(gp.reference_resi, '')) LIKE $${params.length} OR LOWER(COALESCE(s.customer_or_destination, '')) LIKE $${params.length})`;
        }

        sql += ` ORDER BY gp.created_at DESC LIMIT 100`;

        const res = await db.query(sql, params);
        return {
          status: 'ok',
          success: true,
          count: res.rows.length,
          data: res.rows,
        };
      } catch (err: any) {
        console.error('[Orang 4 Gate Pass List Error]:', err.message);
      }
    }

    // In-memory Fallback
    let list = ((memoryStore.gate_passes as Array<Record<string, unknown>>) || []);
    if (statusFilter) {
      list = list.filter((gp) => String(gp.status).toUpperCase() === statusFilter);
    }
    if (search) {
      list = list.filter(
        (gp) =>
          String(gp.pass_code).toLowerCase().includes(search) ||
          String(gp.reference_resi || '').toLowerCase().includes(search) ||
          String(gp.customer_or_destination || '').toLowerCase().includes(search)
      );
    }

    return {
      status: 'ok',
      success: true,
      count: list.length,
      data: list,
    };
  });

  // 10B. GET Daftar EPC Barang yang Siap Melewati Gerbang (Dari Meja Packing & Meja Kasir POS)
  app.get('/api/gate/ready-epcs', async () => {
    if (!isPostgresConnected) {
      return { status: 'ok', success: true, data: { ready: [], in_stock: [] } };
    }

    try {
      const res = await db.query(`
        SELECT
          t.id AS tag_id,
          t.epc,
          t.status AS tag_status,
          i.id AS item_id,
          i.status AS item_status,
          p.sku,
          p.name AS product_name,
          l.code AS rack_code,
          COALESCE(
            (
              SELECT sm.reference_doc
              FROM public.stock_movements sm
              WHERE sm.tag_id = t.id AND sm.qty_change < 0
              ORDER BY sm.created_at DESC
              LIMIT 1
            ),
            (
              SELECT po.order_number
              FROM public.picking_scans ps
              JOIN public.picking_orders po ON po.id = ps.order_id
              WHERE ps.tag_id = t.id AND ps.released_at IS NULL
              ORDER BY ps.scanned_at DESC
              LIMIT 1
            )
          ) AS reference_doc,
          CASE
            WHEN EXISTS (
              SELECT 1 FROM public.stock_movements sm
              WHERE sm.tag_id = t.id AND sm.movement_type = 'POS_SALE'
            ) THEN 'MEJA_KASIR_POS'
            WHEN EXISTS (
              SELECT 1 FROM public.picking_scans ps
              WHERE ps.tag_id = t.id AND ps.released_at IS NULL
            ) THEN 'MEJA_PACKING'
            ELSE 'OUTBOUND_GUDANG'
          END AS source_channel
        FROM public.tags t
        INNER JOIN public.items i ON i.tag_id = t.id
        INNER JOIN public.products p ON p.id = i.product_id
        LEFT JOIN public.locations l ON l.id = i.location_id
        WHERE t.status IN ('AUTHORIZED_OUT', 'IN_STOCK', 'RESERVED')
        ORDER BY
          CASE WHEN t.status = 'AUTHORIZED_OUT' THEN 0 ELSE 1 END,
          t.updated_at DESC
      `);

      const ready = res.rows.filter((r) => r.tag_status === 'AUTHORIZED_OUT');
      const in_stock = res.rows.filter((r) => r.tag_status !== 'AUTHORIZED_OUT');

      return {
        status: 'ok',
        success: true,
        data: {
          ready,
          in_stock,
        },
      };
    } catch (err: any) {
      console.error('[Orang 4 Ready EPCs Error]:', err.message);
      return { status: 'error', success: false, data: { ready: [], in_stock: [] } };
    }
  });

  // 10C. POST Sensor Antena Gerbang Membaca EPC Barang Secara Langsung (Otomatis Lolos / Alarm Breach)
  app.post('/api/gate/scan-epc', async (request, reply) => {
    const body = (request.body as Record<string, any>) || {};
    const rawEpc = String(body.epc || '').trim();
    const gate_id = String(body.gate_id || 'GATE-01');
    const antenna_info = String(body.antenna_info || 'Antena 1 & 2 (Portal Gerbang RFID)');
    const rssi = String(body.rssi || '-48 dBm');
    const operator_name = String(body.operator_name || 'Sensor Antena Gerbang Otomatis');

    if (!rawEpc) {
      return reply.code(400).send({
        status: 'error',
        success: false,
        message: 'Kode EPC RFID barang wajib diisi!',
      });
    }

    if (!isPostgresConnected) {
      return reply.code(503).send({
        status: 'error',
        success: false,
        message: 'Database PostgreSQL belum terhubung.',
      });
    }

    const client = await db.connect();
    let txStarted = false;

    try {
      await client.query('BEGIN');
      txStarted = true;

      // 1. Cari tag & item berdasarkan EPC
      const tagRes = await client.query(
        `SELECT
           t.id AS tag_id,
           t.epc,
           t.status AS tag_status,
           i.id AS item_id,
           i.status AS item_status,
           p.sku,
           p.name AS product_name,
           l.code AS rack_code
         FROM public.tags t
         LEFT JOIN public.items i ON i.tag_id = t.id
         LEFT JOIN public.products p ON p.id = i.product_id
         LEFT JOIN public.locations l ON l.id = i.location_id
         WHERE t.epc = $1
         LIMIT 1
         FOR UPDATE OF t`,
        [rawEpc]
      );

      if (tagRes.rows.length === 0) {
        await client.query('ROLLBACK');
        txStarted = false;
        return reply.code(404).send({
          status: 'error',
          success: false,
          message: `EPC "${rawEpc}" tidak terdaftar di database RFID gudang!`,
        });
      }

      const tagRow = tagRes.rows[0];

      // 2. Cek jika EPC sudah pernah keluar (EXITED)
      if (tagRow.tag_status === 'EXITED' || tagRow.item_status === 'EXITED') {
        await client.query('ROLLBACK');
        txStarted = false;
        return reply.code(409).send({
          status: 'warn',
          success: false,
          gate_action: 'ALREADY_EXITED',
          message: `Barang EPC ${rawEpc} (${tagRow.product_name || tagRow.sku}) sudah pernah keluar gerbang sebelumnya (EXITED).`,
        });
      }

      // 3. Cek apakah EPC ini sudah diretur atau masih IN_STOCK / RESERVED (BELUM DIOTORISASI KELUAR)
      if (tagRow.tag_status !== 'AUTHORIZED_OUT') {
        // Picu ALARM KEAMANAN OTOMATIS karena barang melintasi gerbang tanpa selesai Kasir / Packing!
        const eventId = crypto.randomUUID();
        const alarmId = crypto.randomUUID();
        const breachNote = `TERDETEKSI BARANG BELUM BAYAR / BELUM PACKING (${tagRow.tag_status} di Rak ${tagRow.rack_code || '-'}) melintasi ${gate_id}!`;

        await client.query(
          `INSERT INTO public.gate_events (
             id, gate_id, epc, tag_id, item_name, antenna_info, rssi,
             direction, authorization_status, action_taken, event_time
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'OUT', 'UNAUTHORIZED', 'SIRENE DARURAT AKTIF - BARANG BELUM BAYAR/PACKING', NOW())`,
          [
            eventId,
            gate_id,
            rawEpc,
            tagRow.tag_id,
            `${tagRow.product_name || 'Barang Gudang'} (${tagRow.sku || rawEpc})`,
            antenna_info,
            rssi,
          ]
        );

        await client.query(
          `INSERT INTO public.alarms (
             id, gate_event_id, epc, item_name, severity, siren_triggered, wa_notified, status, notes, created_at
           )
           VALUES ($1, $2, $3, $4, 'CRITICAL', true, false, 'ACTIVE', $5, NOW())`,
          [
            alarmId,
            eventId,
            rawEpc,
            `${tagRow.product_name || 'Barang Gudang'} (${tagRow.sku || rawEpc})`,
            breachNote,
          ]
        );

        await client.query('COMMIT');
        txStarted = false;

        publishRealtimeEvent('wms/gate/alarm', {
          event: 'SECURITY_BREACH_ALARM',
          severity: 'CRITICAL',
          epc: rawEpc,
          item_name: tagRow.product_name,
          gate_id,
          timestamp: new Date().toISOString(),
        });

        return reply.code(403).send({
          status: 'alarm',
          success: false,
          alarm_triggered: true,
          gate_action: 'ALARM_SIREN',
          message: `🚨 ALARM SIRINE MENYALA! Barang EPC ${rawEpc} (${tagRow.product_name}) masih berstatus ${tagRow.tag_status} (belum bayar di Kasir / belum selesai Packing)!`,
          data: {
            epc: rawEpc,
            sku: tagRow.sku,
            product_name: tagRow.product_name,
            tag_status: tagRow.tag_status,
            event_id: eventId,
            alarm_id: alarmId,
          },
        });
      }

      // 4. EPC berstatus AUTHORIZED_OUT (Sah dari Meja Packing atau Meja Kasir POS)
      // Cari dokumen referensinya (dari stock_movements atau picking_scans)
      const refRes = await client.query(
        `SELECT COALESCE(
           (
             SELECT sm.reference_doc
             FROM public.stock_movements sm
             WHERE sm.tag_id = $1 AND sm.qty_change < 0
             ORDER BY sm.created_at DESC
             LIMIT 1
           ),
           (
             SELECT po.order_number
             FROM public.picking_scans ps
             JOIN public.picking_orders po ON po.id = ps.order_id
             WHERE ps.tag_id = $1 AND ps.released_at IS NULL
             ORDER BY ps.scanned_at DESC
             LIMIT 1
           )
         ) AS reference_doc`,
        [tagRow.tag_id]
      );
      const referenceDoc: string | null = refRes.rows[0]?.reference_doc || null;

      // Cari atau buat Gate Pass terkait secara otomatis di belakang layar
      let activePass: Record<string, any> | null = null;
      if (referenceDoc) {
        const gpRes = await client.query(
          `SELECT * FROM public.gate_passes
           WHERE reference_resi = $1 AND status = 'ACTIVE'
           ORDER BY created_at DESC LIMIT 1
           FOR UPDATE`,
          [referenceDoc]
        );
        activePass = gpRes.rows[0] || null;
      }

      if (!activePass) {
        const autoPassCode = `GP-AUTO-${Math.floor(1000 + Math.random() * 9000)}`;
        const insertGp = await client.query(
          `INSERT INTO public.gate_passes (pass_code, reference_resi, status, valid_until, used_at, created_at)
           VALUES ($1, $2, 'USED', NOW() + INTERVAL '24 hours', NOW(), NOW())
           RETURNING *`,
          [autoPassCode, referenceDoc || `EPC-${rawEpc.slice(-6)}`]
        );
        activePass = insertGp.rows[0];
      }

      // Ubah status EPC ini menjadi EXITED
      await client.query(
        `UPDATE public.tags SET status = 'EXITED', updated_at = NOW() WHERE id = $1`,
        [tagRow.tag_id]
      );
      await client.query(
        `UPDATE public.items SET status = 'EXITED', location_id = NULL, updated_at = NOW() WHERE tag_id = $1`,
        [tagRow.tag_id]
      );

      // Cek apakah semua EPC lain pada dokumen yang sama sudah EXITED; jika sudah, tandai Gate Pass USED & Sales SHIPPED
      if (referenceDoc && activePass.status === 'ACTIVE') {
        const remainingAuthRes = await client.query(
          `SELECT COUNT(*)::int AS remaining
           FROM public.tags t
           WHERE t.status = 'AUTHORIZED_OUT'
             AND (
               EXISTS (
                 SELECT 1 FROM public.stock_movements sm
                 WHERE sm.tag_id = t.id AND sm.reference_doc = $1 AND sm.qty_change < 0
               )
               OR EXISTS (
                 SELECT 1 FROM public.picking_scans ps
                 JOIN public.picking_orders po ON po.id = ps.order_id
                 WHERE ps.tag_id = t.id AND po.order_number = $1 AND ps.released_at IS NULL
               )
             )`,
          [referenceDoc]
        );

        const remainingCount = Number(remainingAuthRes.rows[0]?.remaining || 0);
        if (remainingCount === 0) {
          const updGp = await client.query(
            `UPDATE public.gate_passes SET status = 'USED', used_at = NOW() WHERE id = $1 RETURNING *`,
            [activePass.id]
          );
          activePass = updGp.rows[0] || activePass;

          await client.query(
            `UPDATE public.sales
             SET shipping_status = 'SHIPPED / TELAH KELUAR'
             WHERE id = $1 OR invoice_or_resi = $2`,
            [activePass.sale_id || null, referenceDoc]
          );
        }
      }

      // Catat ke gate_events
      const eventId = crypto.randomUUID();
      await client.query(
        `INSERT INTO public.gate_events (
           id, gate_id, epc, tag_id, item_name, antenna_info, rssi,
           direction, authorization_status, action_taken, gate_pass_id, event_time
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'OUT', 'AUTHORIZED_OUT', 'Lolos Sensor RFID Gerbang (Otomatis via EPC)', $8, NOW())`,
        [
          eventId,
          gate_id,
          rawEpc,
          tagRow.tag_id,
          `${tagRow.product_name || 'Barang'} (${referenceDoc || activePass.pass_code})`,
          antenna_info,
          rssi,
          activePass.id,
        ]
      );

      await client.query('COMMIT');
      txStarted = false;

      publishRealtimeEvent('wms/gate/exit', {
        event: 'GATE_EXIT_CONFIRMED',
        epc: rawEpc,
        pass_code: activePass.pass_code,
        reference_doc: referenceDoc,
        gate_id,
        operator_name,
        timestamp: new Date().toISOString(),
      });

      return reply.send({
        status: 'ok',
        success: true,
        gate_action: 'GREEN_LIGHT_OPEN',
        message: `🟢 LAMPU HIJAU — GERBANG TERBUKA! EPC ${rawEpc} (${tagRow.product_name}) dari dokumen ${referenceDoc || activePass.pass_code} SAH & resmi keluar (EXITED).`,
        data: {
          epc: rawEpc,
          sku: tagRow.sku,
          product_name: tagRow.product_name,
          reference_doc: referenceDoc,
          gate_pass: activePass,
          new_status: 'EXITED',
        },
      });
    } catch (err: any) {
      if (txStarted) {
        await client.query('ROLLBACK').catch(() => undefined);
      }
      console.error('[Orang 4 Direct EPC Gate Scan Error]:', err.message);
      return reply.code(500).send({
        status: 'error',
        success: false,
        message: `Gagal memproses pembacaan EPC di gerbang: ${err.message}`,
      });
    } finally {
      client.release();
    }
  });

  // 11. POST Terbitkan Gate Pass Baru (MVP 2 - Orang 4)
  app.post('/api/gate-passes/generate', async (request, reply) => {
    const body = (request.body as Record<string, any>) || {};
    const {
      sale_id,
      reference_resi,
      reference_type = 'OUTBOUND_SHIPMENT',
      customer_or_destination,
      courier,
      epc_list = [],
      authorized_by,
      valid_hours = 24,
    } = body;

    if (!reference_resi && !sale_id) {
      return reply.code(400).send({
        status: 'error',
        success: false,
        message: 'Nomor resi/invoice atau sale_id wajib diisi untuk menerbitkan Gate Pass',
      });
    }

    const uniqueId = crypto.randomUUID();
    const randomSuffix = Math.floor(1000 + Math.random() * 9000);
    const pass_code = `GP-${Date.now().toString().slice(-4)}-${randomSuffix}`;
    const validUntilDate = new Date(Date.now() + Number(valid_hours) * 3600 * 1000);

    let createdPass: Record<string, any>;

    if (isPostgresConnected) {
      try {
        const insertRes = await db.query(
          `INSERT INTO gate_passes (id, pass_code, sale_id, reference_resi, authorized_by, status, valid_until, created_at)
           VALUES ($1, $2, $3, $4, $5, 'ACTIVE', $6, NOW())
           RETURNING *`,
          [uniqueId, pass_code, sale_id || null, reference_resi || `REF-${randomSuffix}`, authorized_by || null, validUntilDate]
        );
        createdPass = insertRes.rows[0];

        // Jika terdapat daftar tag RFID yang dibawa keluar, perbarui status menjadi AUTHORIZED_OUT
        if (Array.isArray(epc_list) && epc_list.length > 0) {
          await db.query(
            `UPDATE tags SET status = 'AUTHORIZED_OUT', updated_at = NOW() WHERE epc = ANY($1)`,
            [epc_list]
          );
        }

        // Jika sale_id disediakan, perbarui status shipping di sales
        if (sale_id) {
          await db.query(
            `UPDATE sales SET shipping_status = 'GATE_PASS_ISSUED' WHERE id = $1`,
            [sale_id]
          );
        }
      } catch (err: any) {
        console.error('[Orang 4 Gate Pass Generate Error]:', err.message);
        return reply.code(500).send({
          status: 'error',
          success: false,
          message: `Gagal menerbitkan Gate Pass: ${err.message}`,
        });
      }
    } else {
      createdPass = {
        id: uniqueId,
        pass_code,
        sale_id: sale_id || null,
        reference_resi: reference_resi || `REF-${randomSuffix}`,
        authorized_by: authorized_by || null,
        status: 'ACTIVE',
        valid_until: validUntilDate.toISOString(),
        used_at: null,
        created_at: new Date().toISOString(),
        order_type: reference_type,
        customer_or_destination: customer_or_destination || 'Tujuan Terdaftar',
        courier: courier || 'Kurir Outbound',
        total_items: epc_list.length || 1,
      };

      if (!memoryStore.gate_passes) memoryStore.gate_passes = [];
      (memoryStore.gate_passes as Array<Record<string, unknown>>).unshift(createdPass);

      if (Array.isArray(epc_list) && epc_list.length > 0) {
        memoryStore.tags.forEach((t) => {
          if (epc_list.includes(t.epc)) {
            t.status = 'AUTHORIZED_OUT';
          }
        });
      }
    }

    // Catat ke Audit Log
    memoryStore.audit_logs.unshift({
      id: memoryStore.audit_logs.length + 1,
      user_id: 4,
      user_name: 'Security Gatekeeper (Orang 4)',
      action: 'GENERATE_GATE_PASS',
      payload: {
        pass_code,
        reference_resi,
        epc_count: epc_list.length,
      },
      created_at: new Date().toISOString(),
    });

    // Publikasi Real-time MQTT
    publishRealtimeEvent('wms/gate/pass', {
      event: 'GATE_PASS_GENERATED',
      pass_code,
      reference_resi,
      status: 'ACTIVE',
      valid_until: validUntilDate.toISOString(),
      timestamp: new Date().toISOString(),
    });

    return reply.code(201).send({
      status: 'ok',
      success: true,
      message: `Gate Pass resmi ${pass_code} berhasil diterbitkan!`,
      data: createdPass,
    });
  });

  // 12. GET Verifikasi Keabsahan Gate Pass (Scanner Satpam / Reader Gerbang)
  app.get('/api/gate-passes/:code/verify', async (request, reply) => {
    const { code } = request.params as { code: string };

    let pass: Record<string, any> | null = null;
    let associatedSales: Record<string, any> | null = null;

    if (isPostgresConnected) {
      try {
        const gpRes = await db.query(
          `SELECT 
            gp.id,
            gp.pass_code,
            gp.sale_id,
            gp.reference_resi,
            gp.authorized_by,
            u.full_name AS authorized_by_name,
            gp.status,
            gp.valid_until,
            gp.used_at,
            gp.created_at,
            s.order_type,
            s.customer_or_destination,
            s.courier,
            s.total_items,
            s.total_amount
           FROM gate_passes gp
           LEFT JOIN sales s ON gp.sale_id = s.id
           LEFT JOIN users u ON gp.authorized_by = u.id
           WHERE gp.pass_code = $1 OR gp.reference_resi = $1 OR gp.id::text = $1
           LIMIT 1`,
          [code]
        );

        if (gpRes.rows.length > 0) {
          const foundRow = gpRes.rows[0];
          pass = foundRow;
          if (foundRow.sale_id) {
            associatedSales = {
              order_type: foundRow.order_type,
              destination: foundRow.customer_or_destination,
              courier: foundRow.courier,
              total_items: foundRow.total_items,
              total_amount: foundRow.total_amount,
            };
          }
        }
      } catch (err: any) {
        console.error('[Orang 4 Gate Pass Verify Error]:', err.message);
      }
    } else {
      const found = ((memoryStore.gate_passes as Array<Record<string, any>>) || []).find(
        (gp: any) => gp.pass_code === code || gp.reference_resi === code || gp.id === code
      );
      if (found) {
        pass = found;
      }
    }

    if (!pass) {
      return reply.code(404).send({
        status: 'error',
        success: false,
        is_valid: false,
        verification_status: 'NOT_FOUND',
        message: `Nomor Gate Pass "${code}" tidak ditemukan dalam sistem!`,
      });
    }

    const now = new Date();
    const validUntil = pass.valid_until ? new Date(pass.valid_until) : null;
    const isExpired = validUntil && validUntil < now;

    if (pass.status === 'USED') {
      return reply.send({
        status: 'warn',
        success: false,
        is_valid: false,
        verification_status: 'ALREADY_USED',
        message: `PERINGATAN: Gate Pass ${pass.pass_code} sudah pernah digunakan keluar pada ${pass.used_at || 'sebelumnya'}!`,
        data: pass,
      });
    }

    if (pass.status === 'REVOKED' || pass.status === 'CANCELLED') {
      return reply.send({
        status: 'warn',
        success: false,
        is_valid: false,
        verification_status: 'REVOKED',
        message: `PERINGATAN: Gate Pass ${pass.pass_code} telah dibatalkan (REVOKED)! Izin keluar ditolak.`,
        data: pass,
      });
    }

    if (isExpired) {
      return reply.send({
        status: 'warn',
        success: false,
        is_valid: false,
        verification_status: 'EXPIRED',
        message: `PERINGATAN: Masa berlaku Gate Pass ${pass.pass_code} sudah habis!`,
        data: pass,
      });
    }

    return reply.send({
      status: 'ok',
      success: true,
      is_valid: true,
      verification_status: 'AUTHORIZED',
      message: `Gate Pass ${pass.pass_code} SAH & AKTIF. Izin melintas gerbang disetujui!`,
      data: pass,
      details: associatedSales,
    });
  });

  // 13. POST Konfirmasi Barang Keluar Gerbang (Status -> USED & Tag -> EXITED)
  app.post('/api/gate-passes/:code/scan-out', async (request, reply) => {
    const { code } = request.params as { code: string };
    const body = (request.body as Record<string, any>) || {};
    const {
      gate_id = 'GATE-01',
      antenna_info = 'Antena 1 & 2 (Portal Keluar)',
      rssi = '-55 dBm',
      scanned_epcs,
      epc_list,
      epcs,
      epc,
      operator_name = 'Komandan Hendra (Gate)',
    } = body;

    const rawEpcsInput = Array.isArray(scanned_epcs)
      ? scanned_epcs
      : Array.isArray(epc_list)
      ? epc_list
      : Array.isArray(epcs)
      ? epcs
      : typeof epc === 'string' && epc.trim()
      ? [epc.trim()]
      : [];

    if (
      rawEpcsInput.some(
        (item: unknown) => typeof item !== 'string' || !item.trim()
      )
    ) {
      return reply.code(400).send({
        status: 'error',
        success: false,
        message: 'Format daftar EPC yang dipindai tidak valid.',
      });
    }

    const normalizedInputEpcs: string[] = rawEpcsInput.map((item: string) =>
      item.trim()
    );

    if (new Set(normalizedInputEpcs).size !== normalizedInputEpcs.length) {
      return reply.code(400).send({
        status: 'error',
        success: false,
        message: 'Terdapat EPC duplikat dalam daftar scan-out.',
      });
    }

    let updatedPass: Record<string, any> | null = null;

    if (isPostgresConnected) {
      const client = await db.connect();
      let txStarted = false;

      try {
        await client.query('BEGIN');
        txStarted = true;

        // 1. Cari & kunci Gate Pass agar tidak dapat diproses paralel
        const findRes = await client.query(
          `SELECT *
           FROM public.gate_passes
           WHERE pass_code = $1 OR reference_resi = $1 OR id::text = $1
           ORDER BY created_at DESC
           LIMIT 1
           FOR UPDATE`,
          [code]
        );

        if (findRes.rows.length === 0) {
          await client.query('ROLLBACK');
          txStarted = false;
          return reply.code(404).send({
            status: 'error',
            success: false,
            message: `Gate Pass "${code}" tidak ditemukan!`,
          });
        }

        const pass = findRes.rows[0];

        if (pass.status === 'USED') {
          await client.query('ROLLBACK');
          txStarted = false;
          return reply.code(409).send({
            status: 'error',
            success: false,
            message: `Gate Pass ${pass.pass_code} sudah pernah digunakan keluar!`,
          });
        }

        if (pass.status === 'REVOKED' || pass.status === 'CANCELLED') {
          await client.query('ROLLBACK');
          txStarted = false;
          return reply.code(409).send({
            status: 'error',
            success: false,
            message: `Gate Pass ${pass.pass_code} telah dibatalkan (REVOKED) dan tidak boleh keluar gerbang!`,
          });
        }

        if (pass.status !== 'ACTIVE') {
          await client.query('ROLLBACK');
          txStarted = false;
          return reply.code(409).send({
            status: 'error',
            success: false,
            message: `Gate Pass ${pass.pass_code} tidak berstatus ACTIVE (status saat ini: ${pass.status}).`,
          });
        }

        if (pass.valid_until && new Date(pass.valid_until) < new Date()) {
          await client.query('ROLLBACK');
          txStarted = false;
          return reply.code(409).send({
            status: 'error',
            success: false,
            message: `Masa berlaku Gate Pass ${pass.pass_code} sudah habis!`,
          });
        }

        // 2. Ambil dokumen acuan transaksi (reference_resi / invoice_or_resi)
        let referenceDoc: string | null = pass.reference_resi || null;
        if (!referenceDoc && pass.sale_id) {
          const saleRes = await client.query(
            `SELECT invoice_or_resi FROM public.sales WHERE id = $1 LIMIT 1`,
            [pass.sale_id]
          );
          referenceDoc = saleRes.rows[0]?.invoice_or_resi || null;
        }

        // 3. Cek daftar EPC yang terdaftar pada dokumen Gate Pass ini di stock_movements
        const docMovementsRes = referenceDoc
          ? await client.query(
              `SELECT
                 t.id AS tag_id,
                 t.epc,
                 SUM(CASE WHEN sm.qty_change < 0 THEN ABS(sm.qty_change) ELSE 0 END)::INT AS sold_qty,
                 SUM(CASE WHEN sm.qty_change > 0 OR sm.movement_type ILIKE '%RETURN%' THEN ABS(sm.qty_change) ELSE 0 END)::INT AS returned_qty,
                 SUM(sm.qty_change)::INT AS net_qty
               FROM public.stock_movements sm
               INNER JOIN public.tags t ON t.id = sm.tag_id
               WHERE sm.reference_doc = $1
               GROUP BY t.id, t.epc`,
              [referenceDoc]
            )
          : { rows: [] };

        const docMovementMap = new Map<
          string,
          { tag_id: string; epc: string; sold_qty: number; returned_qty: number; net_qty: number }
        >();
        for (const row of docMovementsRes.rows) {
          docMovementMap.set(String(row.epc).trim(), {
            tag_id: row.tag_id,
            epc: String(row.epc).trim(),
            sold_qty: Number(row.sold_qty || 0),
            returned_qty: Number(row.returned_qty || 0),
            net_qty: Number(row.net_qty || 0),
          });
        }

        // Daftar EPC yang benar-benar sah terdaftar dan belum diretur pada Gate Pass ini
        const activeRegisteredEpcs = Array.from(docMovementMap.values())
          .filter((m) => m.sold_qty > 0 && m.returned_qty === 0 && m.net_qty < 0)
          .map((m) => m.epc);

        // Tentukan EPC yang akan divalidasi:
        // - Jika caller mengirim scanned_epcs, wajib validasi seluruh EPC yang dikirim.
        // - Jika caller tidak mengirim scanned_epcs (mis. klik cepat dari UI tanpa daftar EPC),
        //   gunakan activeRegisteredEpcs dari dokumen Gate Pass jika dokumen tersebut tercatat di stock_movements.
        let epcsToProcess: string[] = normalizedInputEpcs;
        if (epcsToProcess.length === 0 && docMovementMap.size > 0) {
          if (activeRegisteredEpcs.length === 0) {
            await client.query('ROLLBACK');
            txStarted = false;
            return reply.code(409).send({
              status: 'error',
              success: false,
              message: `Seluruh barang pada Gate Pass ${pass.pass_code} telah diretur atau tidak ada EPC yang sah untuk keluar gerbang.`,
            });
          }
          epcsToProcess = activeRegisteredEpcs;
        }

        if (epcsToProcess.length > 0) {
          // 4. Kunci baris tags & items untuk seluruh EPC yang dipindai
          const tagItemsRes = await client.query(
            `SELECT
               t.id AS tag_id,
               t.epc,
               t.status AS tag_status,
               i.id AS item_id,
               i.status AS item_status,
               p.name AS product_name
             FROM public.tags t
             LEFT JOIN public.items i ON i.tag_id = t.id
             LEFT JOIN public.products p ON p.id = i.product_id
             WHERE t.epc = ANY($1::text[])
             ORDER BY t.epc
             FOR UPDATE OF t`,
            [epcsToProcess]
          );

          const tagItemMap = new Map<string, Record<string, any>>();
          for (const row of tagItemsRes.rows) {
            tagItemMap.set(String(row.epc).trim(), row);
          }

          // Cek apakah sudah pernah tercatat keluar di gate_events
          const exitedEventsRes = await client.query(
            `SELECT DISTINCT epc
             FROM public.gate_events
             WHERE epc = ANY($1::text[])
               AND direction = 'OUT'
               AND authorization_status = 'AUTHORIZED_OUT'`,
            [epcsToProcess]
          );
          const alreadyExitedEpcs = new Set(
            exitedEventsRes.rows.map((r) => String(r.epc).trim())
          );

          for (const scannedEpc of epcsToProcess) {
            const tagRow = tagItemMap.get(scannedEpc);

            // Validasi 0: EPC harus ada di database
            if (!tagRow) {
              await client.query('ROLLBACK');
              txStarted = false;
              return reply.code(404).send({
                status: 'error',
                success: false,
                message: `Scan-Out ditolak: EPC ${scannedEpc} tidak terdaftar di sistem RFID.`,
              });
            }

            const docRecord = docMovementMap.get(scannedEpc);

            // Validasi 1: Jika EPC sudah memiliki catatan retur pada dokumen ini, tolak!
            if (docRecord && (docRecord.returned_qty > 0 || docRecord.net_qty >= 0)) {
              await client.query('ROLLBACK');
              txStarted = false;
              return reply.code(409).send({
                status: 'error',
                success: false,
                message: `Scan-Out ditolak: EPC ${scannedEpc} sudah diretur dan tidak terdaftar pada Gate Pass aktif ${pass.pass_code}.`,
              });
            }

            // Validasi 2: Setiap EPC harus benar-benar terdaftar pada Gate Pass yang digunakan
            if (docMovementMap.size > 0 && (!docRecord || docRecord.sold_qty <= 0)) {
              await client.query('ROLLBACK');
              txStarted = false;
              return reply.code(409).send({
                status: 'error',
                success: false,
                message: `Scan-Out ditolak: EPC ${scannedEpc} tidak terdaftar pada Gate Pass ${pass.pass_code} (${referenceDoc}).`,
              });
            }

            // Validasi 2b: Bahkan jika Gate Pass dibuat manual tanpa stock_movements,
            // cek apakah EPC ini milik dokumen lain atau sudah pernah diretur sebagai stok aktif
            if (docMovementMap.size === 0 && referenceDoc) {
              const otherDocRes = await client.query(
                `SELECT reference_doc, movement_type
                 FROM public.stock_movements
                 WHERE tag_id = $1
                 ORDER BY created_at DESC
                 LIMIT 1`,
                [tagRow.tag_id]
              );
              const lastMove = otherDocRes.rows[0];
              if (
                lastMove &&
                (String(lastMove.movement_type).toUpperCase().includes('RETURN') ||
                  (lastMove.reference_doc &&
                    lastMove.reference_doc !== referenceDoc &&
                    ['POS_SALE', 'OUTBOUND_SHIPMENT'].includes(
                      String(lastMove.movement_type).toUpperCase()
                    )))
              ) {
                await client.query('ROLLBACK');
                txStarted = false;
                return reply.code(409).send({
                  status: 'error',
                  success: false,
                  message: `Scan-Out ditolak: EPC ${scannedEpc} tidak terdaftar pada Gate Pass ${pass.pass_code}.`,
                });
              }
            }

            // Validasi 3: Pastikan EPC belum pernah digunakan untuk proses keluar (EXITED)
            if (
              tagRow.tag_status === 'EXITED' ||
              tagRow.item_status === 'EXITED' ||
              alreadyExitedEpcs.has(scannedEpc)
            ) {
              await client.query('ROLLBACK');
              txStarted = false;
              return reply.code(409).send({
                status: 'error',
                success: false,
                message: `Scan-Out ditolak: EPC ${scannedEpc} sudah pernah digunakan untuk proses keluar gerbang (EXITED).`,
              });
            }

            // Validasi 4: Tolak EPC yang statusnya IN_STOCK atau belum diotorisasi keluar
            if (
              tagRow.tag_status === 'IN_STOCK' ||
              tagRow.tag_status !== 'AUTHORIZED_OUT'
            ) {
              await client.query('ROLLBACK');
              txStarted = false;
              return reply.code(409).send({
                status: 'error',
                success: false,
                message: `Scan-Out ditolak: EPC ${scannedEpc} berstatus ${tagRow.tag_status} (barang masih IN_STOCK atau sudah diretur).`,
              });
            }

            // Jika item_status IN_STOCK padahal tidak terdaftar sebagai item keluar yang sah di dokumen ini, tolak
            if (tagRow.item_status === 'IN_STOCK' && !docRecord) {
              await client.query('ROLLBACK');
              txStarted = false;
              return reply.code(409).send({
                status: 'error',
                success: false,
                message: `Scan-Out ditolak: Barang dengan EPC ${scannedEpc} masih berstatus IN_STOCK di gudang dan tidak terdaftar pada Gate Pass ${pass.pass_code}.`,
              });
            }
          }

          // 5. Semua EPC valid -> Perbarui status Gate Pass menjadi USED
          const updatePassRes = await client.query(
            `UPDATE public.gate_passes
             SET status = 'USED', used_at = NOW()
             WHERE id = $1 AND status = 'ACTIVE'
             RETURNING *`,
            [pass.id]
          );

          if (updatePassRes.rows.length === 0) {
            throw new Error(`Gagal memperbarui status Gate Pass ${pass.pass_code}.`);
          }
          updatedPass = updatePassRes.rows[0];

          // 6. Perbarui status tags menjadi EXITED & items menjadi EXITED
          await client.query(
            `UPDATE public.tags
             SET status = 'EXITED', updated_at = NOW()
             WHERE epc = ANY($1::text[])`,
            [epcsToProcess]
          );

          await client.query(
            `UPDATE public.items i
             SET status = 'EXITED',
                 location_id = NULL,
                 updated_at = NOW()
             FROM public.tags t
             WHERE i.tag_id = t.id
               AND t.epc = ANY($1::text[])`,
            [epcsToProcess]
          );

          // 7. Catat Gate Events dalam transaksi yang sama
          for (const scannedEpc of epcsToProcess) {
            const tagRow = tagItemMap.get(scannedEpc);
            await client.query(
              `INSERT INTO public.gate_events (
                 id, gate_id, epc, tag_id, item_name, antenna_info, rssi,
                 direction, authorization_status, action_taken, gate_pass_id, event_time
               )
               VALUES ($1, $2, $3, $4, $5, $6, $7, 'OUT', 'AUTHORIZED_OUT', 'Lolos Verifikasi Gate Pass Resmi', $8, NOW())`,
              [
                crypto.randomUUID(),
                gate_id,
                scannedEpc,
                tagRow?.tag_id || null,
                tagRow?.product_name
                  ? `${tagRow.product_name} (${pass.pass_code})`
                  : `Barang Gate Pass ${pass.pass_code}`,
                antenna_info,
                rssi,
                pass.id,
              ]
            );
          }
        } else {
          // Fallback hanya untuk Gate Pass manual tanpa EPC sama sekali
          const updatePassRes = await client.query(
            `UPDATE public.gate_passes
             SET status = 'USED', used_at = NOW()
             WHERE id = $1 AND status = 'ACTIVE'
             RETURNING *`,
            [pass.id]
          );
          updatedPass = updatePassRes.rows[0];

          await client.query(
            `INSERT INTO public.gate_events (
               id, gate_id, epc, item_name, antenna_info, rssi,
               direction, authorization_status, action_taken, gate_pass_id, event_time
             )
             VALUES ($1, $2, $3, $4, $5, $6, 'OUT', 'AUTHORIZED_OUT', 'Lolos Verifikasi Gate Pass Resmi', $7, NOW())`,
            [
              crypto.randomUUID(),
              gate_id,
              'ALL_ITEMS',
              `Muatan Outbound: ${pass.reference_resi || pass.pass_code}`,
              antenna_info,
              rssi,
              pass.id,
            ]
          );
        }

        await client.query(
          `UPDATE public.sales
           SET shipping_status = 'SHIPPED / TELAH KELUAR'
           WHERE id = $1 OR invoice_or_resi = $2`,
          [pass.sale_id || null, referenceDoc || pass.reference_resi || null]
        );

        await client.query('COMMIT');
        txStarted = false;
      } catch (err: any) {
        if (txStarted) {
          await client.query('ROLLBACK').catch(() => undefined);
        }
        console.error('[Orang 4 Gate Scan-Out Error]:', err.message);
        return reply.code(500).send({
          status: 'error',
          success: false,
          message: `Gagal mencatat konfirmasi keluar gerbang: ${err.message}`,
        });
      } finally {
        client.release();
      }
    } else {
      const foundIndex = ((memoryStore.gate_passes as Array<Record<string, any>>) || []).findIndex(
        (gp: any) => gp.pass_code === code || gp.reference_resi === code || gp.id === code
      );

      if (foundIndex === -1) {
        return reply.code(404).send({
          status: 'error',
          success: false,
          message: `Gate Pass "${code}" tidak ditemukan!`,
        });
      }

      const pass = (memoryStore.gate_passes as Array<Record<string, any>>)[foundIndex];
      if (pass.status === 'USED') {
        return reply.code(409).send({
          status: 'error',
          success: false,
          message: `Gate Pass ${pass.pass_code} sudah pernah digunakan keluar!`,
        });
      }
      if (pass.status === 'REVOKED' || pass.status === 'CANCELLED') {
        return reply.code(409).send({
          status: 'error',
          success: false,
          message: `Gate Pass ${pass.pass_code} telah dibatalkan (REVOKED) dan tidak boleh keluar gerbang!`,
        });
      }

      for (const scannedEpc of normalizedInputEpcs) {
        const tag = memoryStore.tags.find((t) => t.epc === scannedEpc);
        if (!tag) {
          return reply.code(404).send({
            status: 'error',
            success: false,
            message: `Scan-Out ditolak: EPC ${scannedEpc} tidak terdaftar di sistem RFID.`,
          });
        }
        if (tag.status === 'EXITED') {
          return reply.code(409).send({
            status: 'error',
            success: false,
            message: `Scan-Out ditolak: EPC ${scannedEpc} sudah pernah digunakan untuk proses keluar gerbang (EXITED).`,
          });
        }
        if (tag.status === 'IN_STOCK' || tag.status !== 'AUTHORIZED_OUT') {
          return reply.code(409).send({
            status: 'error',
            success: false,
            message: `Scan-Out ditolak: EPC ${scannedEpc} berstatus ${tag.status} (barang masih IN_STOCK atau sudah diretur).`,
          });
        }
      }

      pass.status = 'USED';
      pass.used_at = new Date().toISOString();
      updatedPass = pass;

      if (normalizedInputEpcs.length > 0) {
        memoryStore.tags.forEach((t) => {
          if (normalizedInputEpcs.includes(t.epc)) {
            t.status = 'EXITED';
          }
        });
      }

      memoryStore.gate_events.unshift({
        id: crypto.randomUUID(),
        gate_id,
        epc: normalizedInputEpcs.join(', ') || 'ALL_ITEMS',
        item_name: `Muatan Outbound: ${pass.reference_resi || pass.pass_code}`,
        antenna_info,
        rssi,
        direction: 'OUT',
        authorization_status: 'AUTHORIZED_OUT',
        action_taken: 'Lolos Verifikasi Gate Pass Resmi',
        gate_pass_id: pass.id,
        event_time: new Date().toISOString(),
      });
    }

    // Publikasi Real-time MQTT
    publishRealtimeEvent('wms/gate/exit', {
      event: 'GATE_EXIT_CONFIRMED',
      pass_code: updatedPass?.pass_code,
      gate_id,
      operator_name,
      timestamp: new Date().toISOString(),
    });

    return reply.send({
      status: 'ok',
      success: true,
      message: `Konfirmasi berhasil! Barang telah resmi keluar melewati ${gate_id}. Status Gate Pass kini: USED.`,
      data: updatedPass,
    });
  });

  // 14. GET Riwayat Log Aktivitas Lintasan Gerbang RFID
  app.get('/api/gate/events', async (request) => {
    const query = (request.query as Record<string, string>) || {};
    const limit = Number(query.limit) || 50;

    if (isPostgresConnected) {
      try {
        const res = await db.query(
          `SELECT 
            ge.id,
            ge.gate_id,
            ge.epc,
            ge.item_name,
            ge.antenna_info,
            ge.rssi,
            ge.direction,
            ge.authorization_status,
            ge.action_taken,
            ge.gate_pass_id,
            ge.event_time,
            gp.pass_code,
            gp.reference_resi
           FROM gate_events ge
           LEFT JOIN gate_passes gp ON ge.gate_pass_id = gp.id
           ORDER BY ge.event_time DESC
           LIMIT $1`,
          [limit]
        );
        return {
          status: 'ok',
          success: true,
          count: res.rows.length,
          data: res.rows,
        };
      } catch (err: any) {
        console.error('[Orang 4 Gate Events Error]:', err.message);
      }
    }

    const list = (memoryStore.gate_events || []).slice(0, limit);
    return {
      status: 'ok',
      success: true,
      count: list.length,
      data: list,
    };
  });

  // 15. POST Deteksi / Simulasi Pelanggaran Keamanan Gerbang (Anti-Theft Breach)
  app.post('/api/gate/alarm-breach', async (request, reply) => {
    const body = (request.body as Record<string, any>) || {};
    const {
      epc = 'E280-UNAUTH-9999',
      item_name = 'Barang Tanpa Izin Keluar',
      gate_id = 'GATE-01',
      antenna_info = 'Antena 1 (Gerbang Keluar)',
      rssi = '-42 dBm',
      notes = 'Terdeteksi melintasi gerbang tanpa status AUTHORIZED_OUT / tanpa Gate Pass sah',
    } = body;

    const eventId = crypto.randomUUID();
    const alarmId = crypto.randomUUID();

    if (isPostgresConnected) {
      try {
        await db.query(
          `INSERT INTO gate_events (id, gate_id, epc, item_name, antenna_info, rssi, direction, authorization_status, action_taken, event_time)
           VALUES ($1, $2, $3, $4, $5, $6, 'OUT', 'UNAUTHORIZED', 'SIRENE DARURAT DIAKTIFKAN - GERBANG DIKUNCI', NOW())`,
          [eventId, gate_id, epc, item_name, antenna_info, rssi]
        );

        await db.query(
          `INSERT INTO alarms (id, gate_event_id, epc, item_name, severity, siren_triggered, wa_notified, status, notes, created_at)
           VALUES ($1, $2, $3, $4, 'CRITICAL', true, false, 'ACTIVE', $5, NOW())`,
          [alarmId, eventId, epc, item_name, notes]
        );
      } catch (err: any) {
        console.error('[Orang 4 Alarm Breach Error]:', err.message);
      }
    } else {
      memoryStore.gate_events.unshift({
        id: eventId,
        gate_id,
        epc,
        item_name,
        antenna_info,
        rssi,
        direction: 'OUT',
        authorization_status: 'UNAUTHORIZED',
        action_taken: 'SIRENE DARURAT DIAKTIFKAN - GERBANG DIKUNCI',
        event_time: new Date().toISOString(),
      });

      if (!memoryStore.alarms) memoryStore.alarms = [];
      (memoryStore.alarms as Array<Record<string, unknown>>).unshift({
        id: alarmId,
        gate_event_id: eventId,
        epc,
        item_name,
        severity: 'CRITICAL',
        siren_triggered: true,
        wa_notified: false,
        status: 'ACTIVE',
        notes,
        created_at: new Date().toISOString(),
      });
    }

    // Broadcast Alarm via EMQX MQTT
    publishRealtimeEvent('wms/gate/alarm', {
      event: 'SECURITY_BREACH_ALARM',
      severity: 'CRITICAL',
      epc,
      item_name,
      gate_id,
      timestamp: new Date().toISOString(),
    });

    return reply.code(200).send({
      status: 'warn',
      success: true,
      alarm_triggered: true,
      message: '🚨 ALARM KEAMANAN DIAKTIFKAN: Deteksi barang keluar tanpa izin resmi!',
      data: {
        event_id: eventId,
        alarm_id: alarmId,
        epc,
        item_name,
        gate_id,
      },
    });
  });

  // 16. POST & PATCH Pembatalan / Pencabutan Gate Pass (Status ACTIVE -> REVOKED)
  // Mendukung POST (UI Gate Security) & PATCH (Integrasi Retur POS Orang 3)
  const handleCancelGatePass = async (request: any, reply: any) => {
    const { code } = request.params as { code: string };
    const body = (request.body as Record<string, any>) || {};
    const reason = String(body.reason || 'Dibatalkan oleh petugas keamanan gerbang').trim();
    const cancelledBy = String(body.cancelled_by || 'Petugas Keamanan Gerbang').trim();

    let revokedPass: Record<string, any> | null = null;

    if (isPostgresConnected) {
      try {
        const findRes = await db.query(
          `SELECT * FROM gate_passes WHERE pass_code = $1 OR reference_resi = $1 OR id::text = $1 LIMIT 1`,
          [code]
        );

        if (findRes.rows.length === 0) {
          return reply.code(404).send({
            status: 'error',
            success: false,
            message: `Gate Pass "${code}" tidak ditemukan!`,
          });
        }

        const pass = findRes.rows[0];
        if (pass.status === 'USED') {
          return reply.code(400).send({
            status: 'error',
            success: false,
            message: `Gate Pass ${pass.pass_code} sudah digunakan keluar gerbang dan tidak dapat dibatalkan!`,
          });
        }
        if (pass.status === 'REVOKED') {
          return reply.code(400).send({
            status: 'error',
            success: false,
            message: `Gate Pass ${pass.pass_code} sudah berstatus dibatalkan (REVOKED).`,
          });
        }

        const updateRes = await db.query(
          `UPDATE gate_passes SET status = 'REVOKED' WHERE id = $1 RETURNING *`,
          [pass.id]
        );
        revokedPass = updateRes.rows[0];
      } catch (err: any) {
        console.error('[Orang 4 Gate Pass Cancel Error]:', err.message);
        return reply.code(500).send({
          status: 'error',
          success: false,
          message: `Gagal membatalkan Gate Pass: ${err.message}`,
        });
      }
    } else {
      const foundIndex = ((memoryStore.gate_passes as Array<Record<string, any>>) || []).findIndex(
        (gp: any) => gp.pass_code === code || gp.reference_resi === code || gp.id === code
      );

      if (foundIndex === -1) {
        return reply.code(404).send({
          status: 'error',
          success: false,
          message: `Gate Pass "${code}" tidak ditemukan!`,
        });
      }

      const pass = (memoryStore.gate_passes as Array<Record<string, any>>)[foundIndex];
      if (pass.status === 'USED') {
        return reply.code(400).send({
          status: 'error',
          success: false,
          message: `Gate Pass ${pass.pass_code} sudah digunakan keluar gerbang dan tidak dapat dibatalkan!`,
        });
      }
      if (pass.status === 'REVOKED') {
        return reply.code(400).send({
          status: 'error',
          success: false,
          message: `Gate Pass ${pass.pass_code} sudah berstatus dibatalkan (REVOKED).`,
        });
      }

      pass.status = 'REVOKED';
      revokedPass = pass;
    }

    memoryStore.audit_logs.unshift({
      id: memoryStore.audit_logs.length + 1,
      user_id: 4,
      user_name: cancelledBy,
      action: 'REVOKE_GATE_PASS',
      payload: {
        pass_code: revokedPass?.pass_code,
        reference_resi: revokedPass?.reference_resi,
        reason,
      },
      created_at: new Date().toISOString(),
    });

    publishRealtimeEvent('wms/gate/pass', {
      event: 'GATE_PASS_REVOKED',
      pass_code: revokedPass?.pass_code,
      status: 'REVOKED',
      reason,
      cancelled_by: cancelledBy,
      timestamp: new Date().toISOString(),
    });

    return reply.send({
      status: 'ok',
      success: true,
      message: `Gate Pass ${revokedPass?.pass_code} berhasil dibatalkan (REVOKED).`,
      data: revokedPass,
    });
  };

  app.post('/api/gate-passes/:code/cancel', handleCancelGatePass);
  app.patch('/api/gate-passes/:code/cancel', handleCancelGatePass);
}