import { FastifyInstance } from 'fastify';
import { db, isPostgresConnected, memoryStore, getCalculatedLedgerStock } from '../../config/db';
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
      return { status: 'ok', success: true, data: res.rows };
    }
    return { status: 'ok', success: true, data: memoryStore.stocktake_sessions };
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

      // 3. Ambil daftar EPC barang yang seharusnya ada di zona sesi
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

      // Ambil ringkasan stok sistem per produk berdasarkan zona
const systemStockResult = await db.query(
  `
  SELECT
    p.id AS product_id,
    p.sku,
    p.name AS product_name,
    COUNT(i.id)::INT AS system_stock
  FROM items i
  JOIN products p ON i.product_id = p.id
  JOIN locations l ON i.location_id = l.id
  JOIN tags t ON i.tag_id = t.id
  WHERE l.zone_code = $1
    AND i.status = 'IN_STOCK'
    AND t.status = 'IN_STOCK'
  GROUP BY p.id, p.sku, p.name
  ORDER BY p.sku ASC
  `,
  [session.zone_code]
);

// Tambahkan tepat di bawah systemStockResult
const scannedStockResult = await db.query(
  `
  SELECT
    p.id AS product_id,
    p.sku,
    p.name AS product_name,
    COUNT(DISTINCT t.epc)::INT AS scanned_stock
  FROM tags t
  JOIN items i ON i.tag_id = t.id
  JOIN products p ON i.product_id = p.id
  JOIN locations l ON i.location_id = l.id
  WHERE t.epc = ANY($1::text[])
    AND l.zone_code = $2
    AND i.status = 'IN_STOCK'
    AND t.status = 'IN_STOCK'
  GROUP BY p.id, p.sku, p.name
  ORDER BY p.sku ASC
  `,
  [uniqueEpcs, session.zone_code]
);
  

      const expectedEpcs = new Set(
        expectedResult.rows.map((item) => item.epc)
      );

      // 4. Cari EPC hasil scan di database
      const actualResult = uniqueEpcs.length > 0
  ? await db.query(
      `
      SELECT
        t.epc,
        l.zone_code,
        p.id AS product_id,
        p.sku,
        p.name AS product_name
      FROM tags t
      LEFT JOIN items i ON i.tag_id = t.id
      LEFT JOIN products p ON i.product_id = p.id
      LEFT JOIN locations l ON i.location_id = l.id
      WHERE t.epc = ANY($1::text[])
      `,
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

for (const epc of uniqueEpcs) {
  if (expectedEpcs.has(epc)) {
    matchedCount++;
  } else if (actualMap.has(epc)) {
    misplacedCount++;

    const actualItem = actualResult.rows.find(
      (item) => item.epc === epc
    );

    discrepancies.push({
      epc,
      type: 'MISPLACED',
      product_id: actualItem?.product_id,
      sku: actualItem?.sku,
      product_name: actualItem?.product_name,
      actual_zone: actualItem?.zone_code,
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
     discrepancies = $5,
     status = 'COMPLETED_PENDING_APPROVAL'
 WHERE id = $6
   AND status = 'IN_PROGRESS'
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
  data: {
    ...updateResult.rows[0],
    system_stock: systemStockResult.rows,
    scanned_stock: scannedStockResult.rows,
  },
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
      const { session_code, adjustments } = request.body as {
        session_code: string;
        adjustments: {
          product_id: string;
          diff_qty: number;
        }[];
      };

      const user = request.user;

      // 1. Validasi input
      if (
        !session_code ||
        !Array.isArray(adjustments) ||
        adjustments.some(
          (item) =>
            !item.product_id ||
            !Number.isInteger(item.diff_qty) ||
            item.diff_qty === 0
        )
      ) {
        return reply.code(400).send({
          success: false,
          message: 'Data persetujuan atau penyesuaian tidak valid.',
        });
      }

      const productIds = adjustments.map((item) => item.product_id);

      if (new Set(productIds).size !== productIds.length) {
        return reply.code(400).send({
          success: false,
          message: 'Produk yang sama tidak boleh dikirim dua kali.',
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

        // 2. Periksa dan kunci sesi opname
        const sessionResult = await client.query(
          `SELECT id, status, zone_code
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

        const session = sessionResult.rows[0];

        if (session.status !== 'COMPLETED_PENDING_APPROVAL') {
          await client.query('ROLLBACK');

          return reply.code(400).send({
            success: false,
            message: 'Sesi ini sudah tidak dapat disetujui.',
          });
        }

        // 3. Cari lokasi rak berdasarkan zona sesi
        const locationResult = await client.query(
          `SELECT id, code
           FROM locations
           WHERE zone_code = $1
             AND location_type = 'RACK'
           LIMIT 1`,
          [session.zone_code]
        );

        if (locationResult.rows.length === 0) {
          await client.query('ROLLBACK');

          return reply.code(404).send({
            success: false,
            message: 'Lokasi rak untuk zona opname tidak ditemukan.',
          });
        }

        const location = locationResult.rows[0];
        const ledgerEntries = [];

        // 4. Proses seluruh penyesuaian produk
        for (let index = 0; index < adjustments.length; index++) {
          const adjustment = adjustments[index];

          const productResult = await client.query(
            `SELECT p.id, p.sku
             FROM products p
             WHERE p.id = $1
               AND EXISTS (
                 SELECT 1
                 FROM items i
                 JOIN locations l ON i.location_id = l.id
                 WHERE i.product_id = p.id
                   AND l.zone_code = $2
                   AND i.status = 'IN_STOCK'
               )`,
            [adjustment.product_id, session.zone_code]
          );

          if (productResult.rows.length === 0) {
            throw new Error(
              `Produk ${adjustment.product_id} tidak ditemukan di zona opname.`
            );
          }

          const product = productResult.rows[0];
          const diffQty = adjustment.diff_qty;
          const isIncrease = diffQty > 0;

          const txCode = `TX-OPN-${Date.now()}-${index + 1}`;

          const movementType = isIncrease
            ? 'Stock Adjustment - Increase'
            : 'Stock Adjustment - Decrease';

          
const ledgerResult = await client.query(
  `INSERT INTO stock_movements (
    tx_code,
    movement_type,
    product_id,
    sku,
    from_location,
    to_location,
    qty_change,
    qty_label,
    reference_doc,
    performed_by_name,
    performed_by,
    from_location_id,
    to_location_id
  )
  VALUES (
    $1, $2, $3, $4, $5, $6,
    $7, $8, $9, $10, $11, $12, $13
  )
  RETURNING *`,
  [
    txCode,
    movementType,
    product.id,
    product.sku,
    isIncrease
      ? 'Penyesuaian stok'
      : `Rak ${location.code}`,
    isIncrease
      ? `Rak ${location.code}`
      : 'Penyesuaian stok',
    diffQty,
    `${Math.abs(diffQty)} Unit`,
    session_code,
    user.full_name || user.username,
    user.id,
    isIncrease ? null : location.id,
    isIncrease ? location.id : null,
  ]
);


          ledgerEntries.push(ledgerResult.rows[0]);
        }

        // 5. Perbarui status sesi setelah semua transaksi berhasil
        await client.query(
          `UPDATE stocktake_sessions
           SET status = 'APPROVED',
               approved_by = $1,
               approved_at = NOW()
           WHERE id = $2`,
          [user.id, session.id]
        );

        await client.query('COMMIT');

        // 6. Kirim notifikasi MQTT
        publishRealtimeEvent('wms/stock/realtime', {
          event: 'STOCKTAKE_APPROVED',
          session_code,
          ledgerEntries,
        });

        return reply.send({
          success: true,
          message: 'Persetujuan stock opname berhasil.',
          total_adjustments: ledgerEntries.length,
          ledger: ledgerEntries,
        });

              } catch (error) {
        await client.query('ROLLBACK');

        console.error(
          '[STOCKTAKE] Gagal menyetujui opname:',
          error
        );

        return reply.code(500).send({
          success: false,
          message: 'Gagal memproses persetujuan stock opname.',
          error:
            error instanceof Error
              ? error.message
              : 'Terjadi kesalahan pada server.',
        });
      } finally {
        client.release();
      }
    }
  );
}