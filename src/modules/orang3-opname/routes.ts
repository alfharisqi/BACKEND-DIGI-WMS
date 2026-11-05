import { FastifyInstance } from 'fastify';
import { db, isPostgresConnected, memoryStore } from '../../config/db';
import { publishRealtimeEvent } from '../../config/mqtt';
import { authenticate, requireRoles } from '../../middleware/auth';

/**
 * ============================================================================
 * MODUL ORANG 3: STOCK OPNAME HANDHELD RFID & REKONSILIASI SELISIH
 * ============================================================================
 */
export async function orang3OpnameRoutes(app: FastifyInstance) {

  // 1. POST Membuka Sesi Stock Opname Baru
  app.post(
    '/api/stocktake/sessions',
    {
      preHandler: [
        authenticate,
        requireRoles('WAREHOUSE_STAFF', 'SUPERVISOR'),
      ],
    },
    async (request, reply) => {
      try {
        // 1. Mengambil data dari frontend
        const { zone_code, scanner_device } = request.body as {
          zone_code: string;
          scanner_device?: string;
        };

        // 2. Mengambil identitas pengguna yang login
        const user = request.user;

        if (!user) {
          return reply.code(401).send({
            success: false,
            message: 'Pengguna belum login.',
          });
        }

        // 3. Memastikan ID pengguna berbentuk UUID
        const uuidRegex =
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

        if (
          typeof user.id !== 'string' ||
          !uuidRegex.test(user.id)
        ) {
          return reply.code(400).send({
            success: false,
            message: 'ID pengguna bukan UUID yang valid.',
          });
        }

        // 4. Memvalidasi zona
        if (!zone_code || !zone_code.trim()) {
          return reply.code(400).send({
            success: false,
            message: 'Kode zona wajib diisi.',
          });
        }

        if (!isPostgresConnected) {
          return reply.code(503).send({
            success: false,
            message: 'Database Supabase belum terhubung.',
          });
        }

        // 5. Memeriksa apakah zona tersedia
        const zoneResult = await db.query(
          `SELECT id, zone_code
           FROM locations
           WHERE zone_code = $1
           LIMIT 1`,
          [zone_code.trim()]
        );

        if (zoneResult.rows.length === 0) {
          return reply.code(404).send({
            success: false,
            message: `Zona ${zone_code} tidak ditemukan.`,
          });
        }

        // 6. Menghitung barang yang tersedia di zona tersebut
        const itemResult = await db.query(
          `SELECT COUNT(*)::int AS total_expected
           FROM items i
           JOIN locations l ON i.location_id = l.id
           JOIN tags t ON i.tag_id = t.id
           WHERE l.zone_code = $1
             AND i.status = 'IN_STOCK'
             AND t.status = 'IN_STOCK'`,
          [zone_code.trim()]
        );

        const totalExpected = itemResult.rows[0].total_expected;

        if (totalExpected === 0) {
          return reply.code(400).send({
            success: false,
            message: `Tidak ada barang tersedia di zona ${zone_code}.`,
          });
        }

        // 7. Membuat kode sesi
        const sessionCode =
          `OPN-${zone_code.trim()}-${Date.now()}`;

        // 8. Menyimpan sesi ke Supabase
        const sessionResult = await db.query(
          `INSERT INTO stocktake_sessions (
            session_code,
            zone_code,
            scanner_device,
            total_expected,
            total_scanned,
            matched_count,
            missing_count,
            misplaced_count,
            status,
            conducted_by
          )
          VALUES ($1, $2, $3, $4, 0, 0, 0, 0, 'IN_PROGRESS', $5)
          RETURNING *`,
          [
            sessionCode,
            zone_code.trim(),
            scanner_device || 'HANDHELD-SIM-01',
            totalExpected,
            user.id,
          ]
        );

        const newSession = sessionResult.rows[0];

        // 9. Mengirim informasi sesi melalui MQTT
        publishRealtimeEvent(
          `wms/opname/${newSession.id}/scan`,
          {
            event: 'STOCKTAKE_STARTED',
            session: newSession,
          }
        );

        // 10. Mengirim hasil kepada frontend
        return reply.code(201).send({
          success: true,
          message: 'Sesi Stock Opname berhasil dibuat.',
          data: newSession,
        });
      } catch (error) {
        console.error('[STOCKTAKE] Gagal membuka sesi:', error);

        return reply.code(500).send({
          success: false,
          message: 'Gagal membuat sesi Stock Opname.',
        });
      }
    }
  );
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
