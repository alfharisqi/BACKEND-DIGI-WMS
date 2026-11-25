import { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
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
        const body = (request.body ?? {}) as Record<string, unknown>;
        const zone_code = body.zone_code;
        const scanner_device = body.scanner_device;

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
        if (typeof zone_code !== 'string' || !zone_code.trim() || zone_code.trim().length > 80) {
          return reply.code(400).send({
            success: false,
            message: 'Kode zona wajib diisi dan maksimal 80 karakter.',
          });
        }

        if (scanner_device !== undefined &&
            (typeof scanner_device !== 'string' || !scanner_device.trim() || scanner_device.length > 120)) {
          return reply.code(400).send({
            success: false,
            message: 'Identitas perangkat tidak valid.',
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
        const sessionCode = `OPN-${zone_code.trim()}-${Date.now()}-${randomUUID().slice(0, 8)}`;

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
            (typeof scanner_device === 'string' ? scanner_device.trim() : '') || 'HANDHELD-SIM-01',
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

  // Return only zones that have eligible stock, using the same predicate as session creation.
  app.get(
    '/api/stocktake/zones',
    {
      preHandler: [
        authenticate,
        requireRoles('WAREHOUSE_STAFF', 'SUPERVISOR'),
      ],
    },
    async (request, reply) => {
      if (!isPostgresConnected) {
        return reply.code(503).send({
          success: false,
          message: 'Daftar zona opname membutuhkan koneksi PostgreSQL.',
        });
      }

      try {
        const result = await db.query(`
          SELECT
            l.zone_code,
            COUNT(DISTINCT t.epc)::INT AS total_expected
          FROM items i
          JOIN locations l ON i.location_id = l.id
          JOIN tags t ON i.tag_id = t.id
          WHERE i.status = 'IN_STOCK'
            AND t.status = 'IN_STOCK'
          GROUP BY l.zone_code
          ORDER BY l.zone_code ASC
        `);

        return reply.send({ success: true, data: result.rows });
      } catch (error) {
        request.log.error(error, 'Gagal mengambil zona Stock Opname');
        return reply.code(500).send({
          success: false,
          message: 'Gagal mengambil daftar zona opname.',
        });
      }
    }
  );

  // Provide the registered EPC catalog for one zone to the handheld/web demo.
  app.get(
    '/api/stocktake/zones/:zone_code/epcs',
    {
      preHandler: [
        authenticate,
        requireRoles('WAREHOUSE_STAFF', 'SUPERVISOR'),
      ],
    },
    async (request, reply) => {
      if (!isPostgresConnected) {
        return reply.code(503).send({
          success: false,
          message: 'Katalog EPC zona membutuhkan koneksi PostgreSQL.',
        });
      }

      const { zone_code } = request.params as { zone_code: string };
      const zoneCode = String(zone_code || '').trim();
      if (!zoneCode || zoneCode.length > 80) {
        return reply.code(400).send({ success: false, message: 'Kode zona tidak valid.' });
      }

      try {
        const result = await db.query(
          `SELECT p.id AS product_id, p.sku, p.name AS product_name,
                  ARRAY_AGG(t.epc ORDER BY t.epc) AS epcs
           FROM items i
           JOIN locations l ON l.id = i.location_id
           JOIN tags t ON t.id = i.tag_id
           JOIN products p ON p.id = i.product_id
           WHERE l.zone_code = $1
             AND i.status = 'IN_STOCK'
             AND t.status = 'IN_STOCK'
           GROUP BY p.id, p.sku, p.name
           ORDER BY p.sku ASC`,
          [zoneCode]
        );
        const misplacedSampleResult = await db.query(
          `SELECT t.epc, l.zone_code, p.id AS product_id
           FROM items i
           JOIN locations l ON l.id = i.location_id
           JOIN tags t ON t.id = i.tag_id
           JOIN products p ON p.id = i.product_id
           WHERE l.zone_code <> $1
             AND i.status = 'IN_STOCK'
             AND t.status = 'IN_STOCK'
           ORDER BY l.zone_code ASC, t.epc ASC
           LIMIT 1`,
          [zoneCode]
        );

        return reply.send({
          success: true,
          data: {
            zone_code: zoneCode,
            products: result.rows,
            epcs: result.rows.flatMap((row) => row.epcs),
            misplaced_sample: misplacedSampleResult.rows[0] || null,
          },
        });
      } catch (error) {
        request.log.error(error, 'Gagal mengambil katalog EPC zona');
        return reply.code(500).send({ success: false, message: 'Gagal mengambil katalog EPC zona.' });
      }
    }
  );

  // 1. GET Daftar Sesi Stock Opname
  app.get(
    '/api/stocktake/sessions',
    {
      preHandler: [
        authenticate,
        requireRoles('WAREHOUSE_STAFF', 'SUPERVISOR'),
      ],
    },
    async (request) => {
      const user = request.user!;
      const isSupervisor = ['SUPERVISOR', 'ADMIN'].includes(
        String(user.role).toUpperCase()
      );

    if (isPostgresConnected) {
      const res = isSupervisor
        ? await db.query('SELECT * FROM stocktake_sessions ORDER BY created_at DESC')
        : await db.query(
            'SELECT * FROM stocktake_sessions WHERE conducted_by = $1 ORDER BY created_at DESC',
            [user.id]
          );
      return { status: 'ok', success: true, data: res.rows };
    }
    const sessions = isSupervisor
      ? memoryStore.stocktake_sessions
      : memoryStore.stocktake_sessions.filter(
          (session) => String(session.conducted_by) === String(user.id)
        );
    return { status: 'ok', success: true, data: sessions };
    }
  );

// 2. POST Mengirim Hasil Scan RFID ke Sesi Stock Opname
app.post(
  '/api/stocktake/scan-submit',
  {
    preHandler: [
      authenticate,
      requireRoles('WAREHOUSE_STAFF', 'SUPERVISOR'),
    ],
  },
  async (request, reply) => {
  try {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const session_id = body.session_id;
    const scanned_epcs = body.scanned_epcs;

      // Validasi input
if (typeof session_id !== 'string' || !session_id.trim() || !Array.isArray(scanned_epcs)) {
  return reply.code(400).send({
    success: false,
    message: 'ID sesi dan daftar EPC wajib diisi.',
  });
}

if (scanned_epcs.length > 5000 || scanned_epcs.some(
  (epc) => typeof epc !== 'string' || !epc.trim() || epc.trim().length > 256
)) {
  return reply.code(400).send({
    success: false,
    message: 'Daftar EPC tidak valid atau melebihi batas 5000 tag.',
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
        `SELECT id, zone_code, status, conducted_by
         FROM stocktake_sessions
         WHERE id = $1`,
          [session_id.trim()]
      );

      if (sessionResult.rows.length === 0) {
        return reply.code(404).send({
          success: false,
          message: 'Sesi stock opname tidak ditemukan.',
        });
      }

      const session = sessionResult.rows[0];

      const isSupervisor = ['SUPERVISOR', 'ADMIN'].includes(
        String(request.user?.role || '').toUpperCase()
      );
      if (!isSupervisor && String(session.conducted_by) !== String(request.user?.id)) {
        return reply.code(403).send({
          success: false,
          message: 'Anda tidak memiliki akses untuk mengirim scan ke sesi ini.',
        });
      }

      if (session.status !== 'IN_PROGRESS') {
        return reply.code(400).send({
          success: false,
          message: 'Sesi ini tidak sedang berlangsung.',
        });
      }

      // 2. Hilangkan EPC duplikat
      const uniqueEpcs = [
        ...new Set(
          scanned_epcs.map((epc) => epc.trim())
        ),
      ];

      // 3. Ambil daftar EPC barang yang seharusnya ada di zona sesi
      const expectedResult = await db.query(
  `
  SELECT
    t.epc,
    p.id AS product_id,
    p.sku,
    p.name AS product_name
  FROM items i
  JOIN locations l ON i.location_id = l.id
  JOIN tags t ON i.tag_id = t.id
  JOIN products p ON i.product_id = p.id
  WHERE l.zone_code = $1
    AND i.status = 'IN_STOCK'
    AND t.status = 'IN_STOCK'
  `,
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
  

      
// 3. Buat pemetaan EPC yang seharusnya berada di zona
const expectedMap = new Map(
  expectedResult.rows.map((item) => [item.epc, item])
);

const expectedEpcs = new Set(expectedMap.keys());

// 4. Cari EPC hasil scan di database
const actualResult = uniqueEpcs.length > 0
  ? await db.query(
      `
      SELECT
        t.epc,
        t.status AS tag_status,
        i.status AS item_status,
        i.id AS item_id,
        i.tag_id,
        i.location_id,
        l.zone_code,
        l.code AS location_code,
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
  actualResult.rows.map((item) => [item.epc, item])
);

// 5. Hitung hasil scan
let matchedCount = 0;
let misplacedCount = 0;

const discrepancies: Array<Record<string, unknown>> = [];
const scannedEpcs = new Set(uniqueEpcs);

for (const epc of uniqueEpcs) {
  const expectedItem = expectedMap.get(epc);
  const actualItem = actualMap.get(epc);

  if (expectedItem) {
    matchedCount++;
    continue;
  }

  if (
    actualItem &&
    actualItem.tag_status === 'IN_STOCK' &&
    actualItem.item_status === 'IN_STOCK' &&
    actualItem.zone_code &&
    actualItem.zone_code !== session.zone_code
  ) {
    misplacedCount++;

    discrepancies.push({
      epc,
      type: 'MISPLACED',
      item_id: actualItem.item_id,
      tag_id: actualItem.tag_id,
      actual_location_id: actualItem.location_id,
      actual_location_code: actualItem.location_code,
      product_id: actualItem.product_id,
      sku: actualItem.sku,
      product_name: actualItem.product_name,
      actual_zone: actualItem.zone_code,
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
for (const [epc, expectedItem] of expectedMap) {
  if (!scannedEpcs.has(epc)) {
    discrepancies.push({
      epc,
      type: 'MISSING',
      product_id: expectedItem.product_id,
      sku: expectedItem.sku,
      product_name: expectedItem.product_name,
      expected_zone: session.zone_code,
    });
  }
}

const missingCount = discrepancies.filter(
  (item) => item.type === 'MISSING'
).length;


      
      // 6. Simpan hasil rekonsiliasi dan snapshot ke sesi yang sama
      const auditSnapshot = {
        zone_code: session.zone_code,
        system_stock: systemStockResult.rows,
        scanned_stock: scannedStockResult.rows,
        scanned_at: new Date().toISOString(),
      };

      const updateResult = await db.query(
        `
        UPDATE stocktake_sessions
        SET total_scanned = $1,
            matched_count = $2,
            missing_count = $3,
            misplaced_count = $4,
            discrepancies = $5,
            audit_snapshot = $6::jsonb,
            status = 'COMPLETED_PENDING_APPROVAL'
        WHERE id = $7
          AND status = 'IN_PROGRESS'
        RETURNING *
        `,
        [
          uniqueEpcs.length,
          matchedCount,
          missingCount,
          misplacedCount,
          JSON.stringify(discrepancies),
          JSON.stringify(auditSnapshot),
          session_id,
        ]
      );

      if (updateResult.rows.length === 0) {
        return reply.code(409).send({
          success: false,
          message: 'Sesi tidak ditemukan atau sudah tidak dalam status IN_PROGRESS.',
        });
      }

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
  }
);



  
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
      const { session_code } = request.body as {
  session_code: string;
};

      const user = request.user;

      // 1. Validasi input
if (
  !session_code ||
  typeof session_code !== 'string' ||
  !session_code.trim()
) {
  return reply.code(400).send({
    success: false,
    message: 'Kode sesi stock opname tidak valid.',
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
  `
  SELECT
  id,
  status,
  zone_code,
  audit_snapshot,
  discrepancies
FROM stocktake_sessions
  WHERE session_code = $1
  FOR UPDATE
  `,
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

        const snapshot = session.audit_snapshot;

if (
  !snapshot ||
  typeof snapshot !== 'object' ||
  snapshot.zone_code !== session.zone_code ||
  !Array.isArray(snapshot.system_stock) ||
  !Array.isArray(snapshot.scanned_stock)
) {
  await client.query('ROLLBACK');

  return reply.code(400).send({
    success: false,
    message: 'Audit snapshot tidak tersedia atau tidak valid.',
  });
}

// Recheck every actionable EPC while the session transaction is locked.
// Missing and misplaced findings become ledger adjustments. Unknown EPCs
// remain report-only because they cannot be linked to a product.
const discrepancies: Array<Record<string, any>> = Array.isArray(session.discrepancies)
  ? session.discrepancies
  : [];
const missingEpcs = discrepancies.filter((item) => item.type === 'MISSING');
const misplacedEpcs = discrepancies.filter((item) => item.type === 'MISPLACED');
const ledgerEntries: Array<Record<string, unknown>> = [];

for (const discrepancy of missingEpcs) {
  const result = await client.query(
    `SELECT t.id AS tag_id, t.status AS tag_status, i.id AS item_id,
            i.product_id, i.location_id, i.status AS item_status,
            p.sku, l.zone_code, l.code AS location_code
     FROM tags t
     JOIN items i ON i.tag_id = t.id
     JOIN products p ON p.id = i.product_id
     JOIN locations l ON l.id = i.location_id
     WHERE t.epc = $1
     FOR UPDATE OF t, i`,
    [discrepancy.epc]
  );
  const item = result.rows[0];
  if (
    !item || item.tag_status !== 'IN_STOCK' || item.item_status !== 'IN_STOCK' ||
    item.zone_code !== session.zone_code || item.product_id !== discrepancy.product_id
  ) {
    await client.query('ROLLBACK');
    return reply.code(409).send({
      success: false,
      message: `Data EPC ${discrepancy.epc} berubah sejak pemindaian. Muat ulang sesi sebelum menyetujui.`,
      epc: discrepancy.epc,
    });
  }
}

for (const discrepancy of misplacedEpcs) {
  const result = await client.query(
    `SELECT t.id AS tag_id, t.status AS tag_status, i.id AS item_id,
            i.product_id, i.location_id, i.status AS item_status,
            p.sku, l.zone_code, l.code AS location_code
     FROM tags t
     JOIN items i ON i.tag_id = t.id
     JOIN products p ON p.id = i.product_id
     JOIN locations l ON l.id = i.location_id
     WHERE t.epc = $1
     FOR UPDATE OF t, i`,
    [discrepancy.epc]
  );
  const item = result.rows[0];
  if (
    !item || item.tag_status !== 'IN_STOCK' || item.item_status !== 'IN_STOCK' ||
    String(item.item_id) !== String(discrepancy.item_id) ||
    String(item.location_id) !== String(discrepancy.actual_location_id) ||
    item.zone_code !== discrepancy.actual_zone || item.zone_code === session.zone_code
  ) {
    await client.query('ROLLBACK');
    return reply.code(409).send({
      success: false,
      message: `Lokasi EPC ${discrepancy.epc} berubah sejak pemindaian. Muat ulang sesi sebelum menyetujui.`,
      epc: discrepancy.epc,
    });
  }
}

// Orang 3 records approved corrections in the shared ledger. The tag/item
// master rows belong to other modules and are intentionally left untouched.
for (const discrepancy of missingEpcs) {
  const itemResult = await client.query(
    `SELECT t.id AS tag_id, i.id AS item_id, i.product_id, p.sku,
            i.location_id, l.code AS location_code
     FROM tags t
     JOIN items i ON i.tag_id = t.id
     JOIN products p ON p.id = i.product_id
     JOIN locations l ON l.id = i.location_id
     WHERE t.epc = $1 AND i.status = 'IN_STOCK' AND t.status = 'IN_STOCK'
     FOR UPDATE OF t, i`,
    [discrepancy.epc]
  );
  const item = itemResult.rows[0];
  if (!item) throw new Error(`Data EPC ${discrepancy.epc} berubah saat approval.`);
  const ledger = await client.query(
    `INSERT INTO stock_movements (
       tx_code, movement_type, product_id, sku, tag_id, from_location, to_location,
       qty_change, qty_label, reference_doc, performed_by_name, performed_by
     ) VALUES ($1, 'STOCKTAKE_ADJUSTMENT', $2, $3, $4, $5, $6, -1, '-1 unit', $7, $8, $9)
     RETURNING *`,
    [
      `OPN-${randomUUID().replace(/-/g, '').slice(0, 20)}-M`, item.product_id,
      item.sku, item.tag_id, item.location_code, 'Barang hilang (opname)',
      session_code, user.full_name || user.username, user.id,
    ]
  );
  ledgerEntries.push(ledger.rows[0]);
}

for (const discrepancy of misplacedEpcs) {
  const itemResult = await client.query(
    `SELECT t.id AS tag_id, i.id AS item_id, i.product_id, p.sku,
            i.location_id, l.code AS location_code
     FROM tags t
     JOIN items i ON i.tag_id = t.id
     JOIN products p ON p.id = i.product_id
     JOIN locations l ON l.id = i.location_id
     WHERE t.epc = $1 AND i.status = 'IN_STOCK' AND t.status = 'IN_STOCK'
     FOR UPDATE OF t, i`,
    [discrepancy.epc]
  );
  const item = itemResult.rows[0];
  if (!item) throw new Error(`Data EPC ${discrepancy.epc} berubah saat approval.`);

  const transferCode = randomUUID().replace(/-/g, '').slice(0, 20);
  const outgoing = await client.query(
    `INSERT INTO stock_movements (
       tx_code, movement_type, product_id, sku, tag_id, from_location, to_location,
       qty_change, qty_label, reference_doc, performed_by_name, performed_by
     ) VALUES ($1, 'STOCKTAKE_ADJUSTMENT', $2, $3, $4, $5, $6, -1, '-1 unit', $7, $8, $9)
     RETURNING *`,
    [
      `OPN-${transferCode}-O`, item.product_id, item.sku, item.tag_id,
      `Zona ${discrepancy.actual_zone}`, `Zona ${session.zone_code}`,
      session_code, user.full_name || user.username, user.id,
    ]
  );
  const incoming = await client.query(
    `INSERT INTO stock_movements (
       tx_code, movement_type, product_id, sku, tag_id, from_location, to_location,
       qty_change, qty_label, reference_doc, performed_by_name, performed_by
     ) VALUES ($1, 'STOCKTAKE_ADJUSTMENT', $2, $3, $4, $5, $6, 1, '+1 unit', $7, $8, $9)
     RETURNING *`,
    [
      `OPN-${transferCode}-I`, item.product_id, item.sku, item.tag_id,
      `Zona ${discrepancy.actual_zone}`, `Zona ${session.zone_code}`,
      session_code, user.full_name || user.username, user.id,
    ]
  );
  ledgerEntries.push(outgoing.rows[0], incoming.rows[0]);
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
          total_adjustments: missingEpcs.length + misplacedEpcs.length,
          total_ledger_entries: ledgerEntries.length,
          ledger: ledgerEntries,
        });

              } catch (error) {
        await client.query('ROLLBACK');

        console.error(
          '[STOCKTAKE] Gagal menyetujui opname:',
          error
        );

        const databaseError = error as { code?: string; message?: string };
        if (
          databaseError.code === '42703' &&
          /audit_snapshot/i.test(databaseError.message || '')
        ) {
          return reply.code(503).send({
            success: false,
            message: 'Kolom snapshot sesi opname belum tersedia. Terapkan migrasi Orang 3 005_orang3_stocktake_reconciliation.sql, lalu mulai ulang backend.',
          });
        }

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
