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

  
  // 2. POST Mengirim Hasil Scan RFID ke Sesi Stock Opname
  app.post('/api/stocktake/scan-submit', async (request, reply) => {
    try {
      const { session_id, scanned_epcs } = request.body as {
        session_id: string;
        scanned_epcs: string[];
      };

      // Validasi input
      if (!session_id || !Array.isArray(scanned_epcs)) {
        return reply.code(400).send({
          success: false,
          message: 'ID sesi dan daftar EPC wajib diisi.',
        });
      }

      if (!isPostgresConnected) {
        return reply.code(503).send({
          success: false,
          message: 'Database Supabase belum terhubung.',
        });
      }

      // 1. Ambil sesi opname yang sudah dibuat
      const sessionResult = await db.query(
        `SELECT id, zone_code, status
         FROM stocktake_sessions
         WHERE id = $1`,
        [session_id]
      );

      if (sessionResult.rows.length === 0) {
        return reply.code(404).send({
          success: false,
          message: 'Sesi stock opname tidak ditemukan.',
        });
      }

      const session = sessionResult.rows[0];

      if (session.status !== 'IN_PROGRESS') {
        return reply.code(400).send({
          success: false,
          message: 'Sesi ini tidak sedang berlangsung.',
        });
      }

      // 2. Hilangkan EPC duplikat
      const uniqueEpcs = [
        ...new Set(
          scanned_epcs
            .filter((epc) => typeof epc === 'string')
            .map((epc) => epc.trim())
            .filter((epc) => epc.length > 0)
        ),
      ];

      // 3. Ambil daftar barang yang seharusnya ada di zona sesi
      const expectedResult = await db.query(
        `SELECT t.epc
         FROM items i
         JOIN locations l ON i.location_id = l.id
         JOIN tags t ON i.tag_id = t.id
         WHERE l.zone_code = $1
           AND i.status = 'IN_STOCK'
           AND t.status = 'IN_STOCK'`,
        [session.zone_code]
      );

      const expectedEpcs = new Set(
        expectedResult.rows.map((item) => item.epc)
      );

      // 4. Cari EPC hasil scan di database
      const actualResult = uniqueEpcs.length > 0
        ? await db.query(
            `SELECT t.epc, l.zone_code
             FROM tags t
             LEFT JOIN items i ON i.tag_id = t.id
             LEFT JOIN locations l ON i.location_id = l.id
             WHERE t.epc = ANY($1::text[])`,
            [uniqueEpcs]
          )
        : { rows: [] };

      const actualMap = new Map(
        actualResult.rows.map((item) => [item.epc, item.zone_code])
      );

      // 5. Hitung hasil scan
let matchedCount = 0;
let misplacedCount = 0;

const discrepancies: Array<Record<string, unknown>> = [];

const scannedEpcs = new Set(uniqueEpcs);

// Periksa semua EPC yang terbaca scanner
for (const epc of uniqueEpcs) {
  if (expectedEpcs.has(epc)) {
    matchedCount++;
  } else if (actualMap.has(epc)) {
    misplacedCount++;

    discrepancies.push({
      epc,
      type: 'MISPLACED',
      actual_zone: actualMap.get(epc),
      expected_zone: session.zone_code,
    });
  } else {
    discrepancies.push({
      epc,
      type: 'UNKNOWN_TAG',
      expected_zone: session.zone_code,
    });
  }
}

// Periksa barang yang seharusnya ada tetapi tidak terbaca
for (const epc of expectedEpcs) {
  if (!scannedEpcs.has(epc)) {
    discrepancies.push({
      epc,
      type: 'MISSING',
      expected_zone: session.zone_code,
    });
  }
}

const missingCount = discrepancies.filter(
  (item) => item.type === 'MISSING'
).length;

      // 6. Simpan hasil rekonsiliasi ke sesi yang sama
      const updateResult = await db.query(
        `UPDATE stocktake_sessions
         SET total_scanned = $1,
             matched_count = $2,
             missing_count = $3,
             misplaced_count = $4,
             discrepancies = $5
         WHERE id = $6
         RETURNING *`,
        [
          uniqueEpcs.length,
          matchedCount,
          missingCount,
          misplacedCount,
          JSON.stringify(discrepancies),
          session_id,
        ]
      );

      // 7. Kirim informasi hasil melalui MQTT
      publishRealtimeEvent(
        `wms/opname/${session_id}/scan`,
        {
          event: 'STOCKTAKE_SCAN_SUBMITTED',
          session: updateResult.rows[0],
        }
      );

      return reply.send({
        success: true,
        message: 'Hasil scan RFID berhasil direkonsiliasi.',
        data: updateResult.rows[0],
      });
    } catch (error) {
      console.error('[STOCKTAKE] Gagal mengirim hasil scan:', error);

      return reply.code(500).send({
        success: false,
        message: 'Gagal memproses hasil scan RFID.',
      });
    }
  });


  
  // 3. POST Persetujuan Supervisor
  app.post(
    '/api/stocktake/approve',
    {
      preHandler: [
        authenticate,
        requireRoles('SUPERVISOR'),
      ],
    },
    async (request, reply) => {
      const {
        session_code,
        product_id,
        diff_qty,
        from_rack,
        to_rack,
      } = request.body as {
        session_code: string;
        product_id: string;
        diff_qty: number;
        from_rack?: string;
        to_rack?: string;
      };

      const user = request.user;

      // 1. Validasi input
      if (
        !session_code ||
        !product_id ||
        !Number.isInteger(diff_qty) ||
        diff_qty === 0
      ) {
        return reply.code(400).send({
          success: false,
          message: 'Data persetujuan atau jumlah selisih tidak valid.',
        });
      }

      if (!user || typeof user.id !== 'string') {
        return reply.code(401).send({
          success: false,
          message: 'Identitas supervisor tidak valid.',
        });
      }

      if (!isPostgresConnected) {
        return reply.code(503).send({
          success: false,
          message: 'Database Supabase belum terhubung.',
        });
      }

      const client = await db.connect();

      try {
        await client.query('BEGIN');

        // 2. Periksa sesi opname
        const sessionResult = await client.query(
          `SELECT id, status
           FROM stocktake_sessions
           WHERE session_code = $1
           FOR UPDATE`,
          [session_code]
        );

        if (sessionResult.rows.length === 0) {
          await client.query('ROLLBACK');

          return reply.code(404).send({
            success: false,
            message: 'Sesi stock opname tidak ditemukan.',
          });
        }

        if (sessionResult.rows[0].status !== 'IN_PROGRESS') {
          await client.query('ROLLBACK');

          return reply.code(400).send({
            success: false,
            message: 'Sesi ini sudah tidak dapat disetujui.',
          });
        }

        // 3. Ambil informasi produk
        const productResult = await client.query(
          `SELECT id, sku
           FROM products
           WHERE id = $1`,
          [product_id]
        );

        if (productResult.rows.length === 0) {
          await client.query('ROLLBACK');

          return reply.code(404).send({
            success: false,
            message: 'Produk tidak ditemukan.',
          });
        }

        const product = productResult.rows[0];

        // 4. Catat penyesuaian ke stock_movements
        const txCode = `TX-OPN-${Date.now()}`;

        const ledgerResult = await client.query(
          `INSERT INTO stock_movements (
            tx_code,
            movement_type,
            product_id,
            sku,
            from_location,
            to_location,
            qty_change,
            reference_doc,
            performed_by_name,
            performed_by
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          RETURNING *`,
          [
            txCode,
            'STOCKTAKE_ADJUSTMENT',
            product.id,
            product.sku,
            from_rack || 'Audit Opname Fisik',
            to_rack || 'Koreksi Buku Besar',
            diff_qty,
            session_code,
            user.full_name || user.username,
            user.id,
          ]
        );

        // 5. Perbarui status sesi opname
        await client.query(
          `UPDATE stocktake_sessions
           SET status = 'DISETUJUI',
               approved_by = $1,
               approved_at = NOW()
           WHERE id = $2`,
          [user.id, sessionResult.rows[0].id]
        );

        await client.query('COMMIT');

        // 6. Kirim notifikasi MQTT
        publishRealtimeEvent('wms/stock/realtime', {
          event: 'STOCKTAKE_APPROVED',
          session_code,
          ledgerEntry: ledgerResult.rows[0],
        });

        return reply.send({
          success: true,
          message: 'Persetujuan stock opname berhasil.',
          ledger: ledgerResult.rows[0],
        });
      } catch (error) {
        await client.query('ROLLBACK');

        console.error('[STOCKTAKE] Gagal menyetujui opname:', error);

        return reply.code(500).send({
          success: false,
          message: 'Gagal memproses persetujuan stock opname.',
        });
      } finally {
        client.release();
      }
    }
  );
}
