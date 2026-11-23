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

// Periksa discrepancy hasil scan
const discrepancies = Array.isArray(session.discrepancies)
  ? session.discrepancies
  : [];

const missingEpcs = discrepancies.filter(
  (item: any) => item.type === 'MISSING'
);

for (const discrepancy of missingEpcs) {
  const epcResult = await client.query(
    `
    SELECT
      t.epc,
      t.status AS tag_status,
      i.status AS item_status,
      l.zone_code
    FROM tags t
    LEFT JOIN items i ON i.tag_id = t.id
    LEFT JOIN locations l ON l.id = i.location_id
    WHERE t.epc = $1
    `,
    [discrepancy.epc]
  );

  const epc = epcResult.rows[0];

  if (
    epc &&
    epc.tag_status === 'IN_STOCK' &&
    epc.item_status === 'IN_STOCK' &&
    epc.zone_code === session.zone_code
  ) {
    await client.query('ROLLBACK');

    return reply.code(409).send({
      success: false,
      message:
        `Approval ditolak. EPC ${discrepancy.epc} ` +
        'masih tercatat IN_STOCK di zona opname. ' +
        'Perlu pemeriksaan fisik terlebih dahulu.',
      epc: discrepancy.epc,
      sku: discrepancy.sku,
      zone_code: epc.zone_code,
    });
  }
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

// 4. Hitung penyesuaian berdasarkan audit_snapshot
type SnapshotStockRow = {
  product_id: string;
  sku: string;
  system_stock?: number;
  scanned_stock?: number;
};

const systemRows = snapshot.system_stock as SnapshotStockRow[];
const scannedRows = snapshot.scanned_stock as SnapshotStockRow[];

const systemMap = new Map(
  systemRows.map((item) => [item.product_id, item])
);

const scannedMap = new Map(
  scannedRows.map((item) => [item.product_id, item])
);

const productIds = new Set([
  ...systemMap.keys(),
  ...scannedMap.keys(),
]);

const adjustments = Array.from(productIds)
  .map((productId) => {
    const systemItem = systemMap.get(productId);
    const scannedItem = scannedMap.get(productId);

    const systemStock = Number(systemItem?.system_stock ?? 0);
    const scannedStock = Number(scannedItem?.scanned_stock ?? 0);

    return {
      product_id: productId,
      sku: systemItem?.sku ?? scannedItem?.sku,
      diff_qty: scannedStock - systemStock,
    };
  })
  .filter((item) => item.diff_qty !== 0);

// 5. Proses seluruh penyesuaian produk
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

  if (product.sku !== adjustment.sku) {
    throw new Error(
      `SKU produk ${adjustment.product_id} tidak sesuai dengan snapshot.`
    );
  }

  const diffQty = adjustment.diff_qty;
  const isIncrease = diffQty > 0;

  // Follow Orang 2's ledger contract and the canonical movement type from
  // the project schema. The signed qty_change carries the adjustment direction.
  const txCode = `OPN-${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  const movementType = 'STOCKTAKE_ADJUSTMENT';

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
        : `Zona ${session.zone_code}`,
      isIncrease
        ? `Zona ${session.zone_code}`
        : 'Penyesuaian stok',
      diffQty,
      `${Math.abs(diffQty)} Unit`,
      session_code,
      user.full_name || user.username,
      user.id,
      null,
      null,
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
