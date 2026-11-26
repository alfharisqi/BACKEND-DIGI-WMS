
import { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { randomUUID } from 'crypto';

import {
  db,
  isPostgresConnected,
  memoryStore,
  getCalculatedLedgerStock,
} from '../../config/db';

import { publishRealtimeEvent } from '../../config/mqtt';
import {
  getAggregatedStockByProduct,
  getStockByRack,
} from './stock.service';

/**
 * ============================================================================
 * MODUL ORANG 2:
 * PENYIMPANAN RAK (PUTAWAY), STOK & IMMUTABLE STOCK LEDGER
 * ============================================================================
 */

export async function orang2InventoryRoutes(app: FastifyInstance) {

  // ==========================================================================
  // 1. GET DENAH LOKASI RAK GUDANG
  // Mengambil data lokasi sesuai struktur tabel PostgreSQL yang aktif.
  // ==========================================================================
  app.get('/api/locations', async (request, reply) => {
    try {
      if (!isPostgresConnected) {
        return reply.code(503).send({
          success: false,
          message: 'Database PostgreSQL belum terhubung.',
        });
      }

      const result = await db.query(`
        WITH item_agg AS (
          SELECT
            i.location_id,
            COUNT(i.id)::INT AS unit_items_count
          FROM items i
          WHERE i.location_id IS NOT NULL
            AND i.status IN ('IN_STOCK', 'RESERVED', 'AUTHORIZED_OUT')
          GROUP BY i.location_id
        ),
        box_agg AS (
          SELECT
            b.location_id,
            COUNT(b.id)::INT AS box_count,
            COALESCE(SUM(b.qty_per_box), 0)::INT AS box_units_count,
            COALESCE(
              json_agg(
                json_build_object(
                  'id', b.id,
                  'box_code', b.box_code,
                  'master_epc', b.master_epc,
                  'box_level', COALESCE(b.box_level, 'INNER'),
                  'qty_per_box', b.qty_per_box,
                  'inner_box_count', COALESCE(b.inner_box_count, 0),
                  'qty_per_inner', COALESCE(b.qty_per_inner, b.qty_per_box),
                  'sku', p.sku,
                  'product_name', p.name,
                  'status', b.status
                )
                ORDER BY COALESCE(b.box_level, 'INNER') DESC, b.box_code ASC
              ),
              '[]'::json
            ) AS boxes
          FROM boxes b
          INNER JOIN products p ON p.id = b.product_id
          WHERE b.location_id IS NOT NULL
            AND b.status = 'IN_RACK'
          GROUP BY b.location_id
        ),
        prod_combined AS (
          SELECT
            i.location_id,
            p.id AS product_id,
            p.sku,
            p.name AS product_name,
            COUNT(i.id)::INT AS unit_qty,
            0::INT AS box_count,
            0::INT AS box_qty
          FROM items i
          INNER JOIN products p ON p.id = i.product_id
          WHERE i.location_id IS NOT NULL
            AND i.status IN ('IN_STOCK', 'RESERVED', 'AUTHORIZED_OUT')
          GROUP BY i.location_id, p.id, p.sku, p.name
          UNION ALL
          SELECT
            b.location_id,
            p.id AS product_id,
            p.sku,
            p.name AS product_name,
            0::INT AS unit_qty,
            COUNT(b.id)::INT AS box_count,
            COALESCE(SUM(b.qty_per_box), 0)::INT AS box_qty
          FROM boxes b
          INNER JOIN products p ON p.id = b.product_id
          WHERE b.location_id IS NOT NULL
            AND b.status = 'IN_RACK'
          GROUP BY b.location_id, p.id, p.sku, p.name
        ),
        prod_summary_per_loc AS (
          SELECT
            location_id,
            json_agg(
              json_build_object(
                'product_id', product_id,
                'sku', sku,
                'product_name', product_name,
                'unit_qty', unit_qty,
                'box_count', box_count,
                'box_qty', box_qty,
                'total_qty', (unit_qty + box_qty)
              )
              ORDER BY sku ASC
            ) AS products_summary
          FROM (
            SELECT
              location_id,
              product_id,
              sku,
              product_name,
              SUM(unit_qty)::INT AS unit_qty,
              SUM(box_count)::INT AS box_count,
              SUM(box_qty)::INT AS box_qty
            FROM prod_combined
            GROUP BY location_id, product_id, sku, product_name
          ) grouped_prod
          GROUP BY location_id
        )
        SELECT
          l.id,
          l.code,
          l.zone_code,
          l.name,
          l.max_capacity,
          COALESCE(ia.unit_items_count, 0)::INT AS unit_items_count,
          COALESCE(ba.box_count, 0)::INT AS box_count,
          COALESCE(ba.box_units_count, 0)::INT AS box_units_count,
          CASE
            WHEN (COALESCE(ia.unit_items_count, 0) + COALESCE(ba.box_units_count, 0)) > 0
              THEN (COALESCE(ia.unit_items_count, 0) + COALESCE(ba.box_units_count, 0))
            ELSE COALESCE(l.current_items_count, 0)
          END::INT AS current_items_count,
          CASE
            WHEN COALESCE(l.max_capacity, 0) <= 0 THEN 'Padat'
            WHEN (
              CASE
                WHEN (COALESCE(ia.unit_items_count, 0) + COALESCE(ba.box_units_count, 0)) > 0
                  THEN (COALESCE(ia.unit_items_count, 0) + COALESCE(ba.box_units_count, 0))
                ELSE COALESCE(l.current_items_count, 0)
              END
            )::NUMERIC / l.max_capacity * 100 < 50 THEN 'Longgar'
            WHEN (
              CASE
                WHEN (COALESCE(ia.unit_items_count, 0) + COALESCE(ba.box_units_count, 0)) > 0
                  THEN (COALESCE(ia.unit_items_count, 0) + COALESCE(ba.box_units_count, 0))
                ELSE COALESCE(l.current_items_count, 0)
              END
            )::NUMERIC / l.max_capacity * 100 <= 85 THEN 'Optimal'
            ELSE 'Padat'
          END AS capacity_status,
          l.location_type,
          COALESCE(ba.boxes, '[]'::json) AS boxes,
          COALESCE(ps.products_summary, '[]'::json) AS products_summary
        FROM locations l
        LEFT JOIN item_agg ia ON ia.location_id = l.id
        LEFT JOIN box_agg ba ON ba.location_id = l.id
        LEFT JOIN prod_summary_per_loc ps ON ps.location_id = l.id
        ORDER BY l.zone_code ASC, l.code ASC
      `);

      return reply.send({
        success: true,
        data: result.rows,
      });

    } catch (error) {
      console.error('DETAIL ERROR GET LOCATIONS:', error);

      const dbError = error as Error & {
        code?: string;
        detail?: string;
      };

      return reply.code(500).send({
        success: false,
        message: 'Gagal mengambil data lokasi rak.',
        error: dbError.message,
        code: dbError.code,
        detail: dbError.detail,
      });
    }
  });


  // ========================================================================== 
  // 2. POST TAMBAH RAK BARU
  // ========================================================================== 
  app.post('/api/locations', async (request, reply) => {
    const {
      code,
      zone_code,
      name,
      max_capacity,
      location_type = 'RACK',
    } = (request.body ?? {}) as {
      code?: string;
      zone_code?: string;
      name?: string;
      max_capacity?: number;
      location_type?: string;
    };

    // Validasi input
    if (
      typeof code !== 'string' ||
      !code.trim() ||
      typeof zone_code !== 'string' ||
      !zone_code.trim() ||
      typeof name !== 'string' ||
      !name.trim() ||
      !Number.isInteger(max_capacity) ||
      Number(max_capacity) <= 0 ||
      location_type !== 'RACK'
    ) {
      return reply.code(400).send({
        success: false,
        message: 'Kode rak, kode zona, nama rak, dan kapasitas wajib diisi dengan benar. Jenis lokasi harus RACK.',
      });
    }

    if (!isPostgresConnected) {
      return reply.code(503).send({
        success: false,
        message: 'Database PostgreSQL belum terhubung.',
      });
    }

    try {
      const result = await db.query(
        `
        INSERT INTO locations (
          code,
          zone_code,
          name,
          max_capacity,
          current_items_count,
          capacity_status,
          location_type
        )
        VALUES ($1, $2, $3, $4, 0, 'Longgar', $5)
        RETURNING *
        `,
        [
          code.trim().toUpperCase(),
          zone_code.trim().toUpperCase(),
          name.trim(),
          max_capacity,
          location_type,
        ]
      );

      return reply.code(201).send({
        success: true,
        message: 'Rak berhasil ditambahkan.',
        data: result.rows[0],
      });

    } catch (error) {
      const dbError = error as Error & { code?: string };

      if (dbError.code === '23505') {
        return reply.code(409).send({
          success: false,
          message: 'Kode rak atau zona sudah digunakan.',
        });
      }

      console.error('DETAIL ERROR POST LOCATIONS:', error);

      return reply.code(500).send({
        success: false,
        message: 'Gagal menambahkan rak.',
        error: dbError.message,
        code: dbError.code,
      });
    }
  });

  // ==========================================================================
  // 3. GET RINGKASAN STOK BARANG
  // Menghitung stok berdasarkan agregasi stock_movements.
  // Tidak mengubah products.current_stock.
  // ==========================================================================
  app.get('/api/inventory/stock', async (request, reply) => {
    try {
      if (isPostgresConnected) {
        const data = await getAggregatedStockByProduct();

        return {
          success: true,
          data,
        };
      }

      return {
        success: true,
        data: getCalculatedLedgerStock(),
      };

    } catch (error) {
      app.log.error(error, 'Gagal menghitung agregasi stok');

      return reply.code(500).send({
        success: false,
        message: 'Gagal menghitung stok berdasarkan ledger.',
      });
    }
  });


  // ==========================================================================
  // 4. GET INVENTARIS STOK BERDASARKAN RAK
  // Menghitung jumlah item IN_STOCK pada setiap rak.
  // Sumber data: items, products, dan locations.
  // ==========================================================================
  app.get('/api/inventory/stock-by-rack', async (request, reply) => {
    try {
      if (!isPostgresConnected) {
        return reply.code(503).send({
          success: false,
          message: 'Inventaris stok per rak membutuhkan koneksi PostgreSQL.',
        });
      }

      const data = await getStockByRack();

      return reply.send({
        success: true,
        data,
      });
    } catch (error) {
      app.log.error(error, 'Gagal mengambil stok per rak');

      return reply.code(500).send({
        success: false,
        message: 'Gagal mengambil inventaris stok per rak.',
      });
    }
  });


  // ==========================================================================
  // 4. GET RIWAYAT BUKU BESAR MUTASI STOK
  // ==========================================================================
  app.get('/api/inventory/ledger', async (request, reply) => {
    try {
      if (isPostgresConnected) {
        const result = await db.query(`
          WITH ledger_calculation AS (
            SELECT
              sm.*,
              COALESCE(p.name, sm.sku) AS product_name,
              COALESCE(
                sm.performed_by_name,
                u.full_name,
                'Tidak diketahui'
              ) AS operator_name,
              SUM(sm.qty_change) OVER (
                PARTITION BY COALESCE(p.id::TEXT, sm.sku)
                ORDER BY sm.created_at ASC, sm.id ASC
                ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
              ) AS running_balance
            FROM stock_movements sm
            LEFT JOIN products p
              ON (
                sm.product_id = p.id
                OR (
                  sm.product_id IS NULL
                  AND sm.sku = p.sku
                )
              )
            LEFT JOIN users u ON sm.performed_by = u.id
          )
          SELECT *
          FROM ledger_calculation
          ORDER BY created_at DESC, id DESC
          LIMIT 100
        `);

        return reply.send({ success: true, data: result.rows });
      }

      // Fallback: hitung saldo kumulatif tanpa mengubah data mutasi.
      const ascending = [...memoryStore.stock_movements].sort((a, b) => {
        const dateDiff = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
        return dateDiff || Number(a.id) - Number(b.id);
      });
      const balances = new Map<string, number>();
      const calculated = ascending.map((movement) => {
        const key = String(movement.product_id ?? movement.sku ?? 'unknown');
        const qtyChange = Number((movement as any).qty_change ?? movement.qty ?? 0);
        const balance = (balances.get(key) ?? 0) + qtyChange;
        balances.set(key, balance);
        return {
          ...movement,
          tx_code: movement.tx_code || `TX-${movement.id}`,
          qty_change: qtyChange,
          product_name: movement.product_name || movement.sku,
          operator_name: movement.operator_name || (movement as any).performed_by_name || 'Tidak diketahui',
          running_balance: balance,
        };
      });

      return reply.send({
        success: true,
        data: calculated.reverse().slice(0, 100),
      });
    } catch (error) {
      app.log.error(error, 'Gagal mengambil riwayat Stock Ledger');
      return reply.code(500).send({
        success: false,
        message: 'Gagal mengambil data buku besar stok.',
      });
    }
  });


  // ==========================================================================
  // 5. POST PROSES PUTAWAY RFID
  // Struktur disesuaikan dengan tabel PostgreSQL yang aktif.
  // Status item, tag, ledger, dan kapasitas rak diperbarui dalam satu transaksi.
  // ==========================================================================
  app.post('/api/inventory/putaway', async (request, reply) => {
    const {
      epc,
      location_code,
      reference_doc = 'PUTAWAY-MANUAL',
    } = (request.body ?? {}) as {
      epc?: string;
      location_code?: string;
      reference_doc?: string;
    };

    if (
      typeof epc !== 'string' ||
      !epc.trim() ||
      typeof location_code !== 'string' ||
      !location_code.trim()
    ) {
      return reply.code(400).send({
        success: false,
        message: 'EPC dan location_code wajib diisi.',
      });
    }

    if (
      typeof reference_doc !== 'string' ||
      !reference_doc.trim() ||
      reference_doc.trim().length > 100
    ) {
      return reply.code(400).send({
        success: false,
        message: 'reference_doc wajib berupa teks dan maksimal 100 karakter.',
      });
    }

    if (!isPostgresConnected) {
      return reply.code(503).send({
        success: false,
        message: 'Database PostgreSQL belum terhubung.',
      });
    }

    let client: PoolClient | null = null;
    let transactionStarted = false;

    try {
      client = await db.connect();
      client.on('error', (clientErr) => {
        app.log.error(clientErr, '[PostgreSQL Client Error in Putaway]');
      });
      await client.query('BEGIN');
      transactionStarted = true;

      // 1. Ambil dan kunci data RFID, item, dan produk.
      const itemResult = await client.query(
        `
        SELECT
          t.id AS tag_id,
          t.epc,
          t.status AS tag_status,
          i.id AS item_id,
          i.status AS item_status,
          i.location_id,
          i.product_id,
          p.sku,
          p.name AS product_name
        FROM tags t
        INNER JOIN items i ON i.tag_id = t.id
        INNER JOIN products p ON p.id = i.product_id
        WHERE t.epc = $1
        FOR UPDATE OF t, i
        `,
        [epc.trim()]
      );

      if (itemResult.rows.length === 0) {
        // Fallback: Cek apakah yang di-scan/diketik adalah Master EPC atau Kode Box (Master/Inner Box)
        const boxResult = await client.query(
          `
          SELECT
            b.*,
            p.sku,
            p.name AS product_name,
            l.code AS current_loc_code,
            l.name AS current_loc_name
          FROM boxes b
          INNER JOIN products p ON p.id = b.product_id
          LEFT JOIN locations l ON l.id = b.location_id
          WHERE UPPER(BTRIM(b.master_epc)) = UPPER($1)
             OR UPPER(BTRIM(b.box_code)) = UPPER($1)
          LIMIT 1
          FOR UPDATE OF b
          `,
          [epc.trim()]
        );

        if (boxResult.rows.length > 0) {
          const box = boxResult.rows[0];
          if (box.status === 'UNPACKED' || box.status === 'SHIPPED') {
            const error = new Error(
              `Putaway Box ditolak. Box ${box.box_code} berstatus ${box.status}.`
            ) as Error & { statusCode: number };
            error.statusCode = 409;
            throw error;
          }

          const destRes = await client.query(
            `SELECT id, code, name, location_type FROM locations WHERE code = $1 LIMIT 1 FOR UPDATE`,
            [location_code.trim().toUpperCase()]
          );
          const destRack = destRes.rows[0];
          if (!destRack) {
            const error = new Error('Lokasi rak tujuan tidak ditemukan.') as Error & { statusCode: number };
            error.statusCode = 404;
            throw error;
          }
          if (destRack.location_type !== 'RACK') {
            const error = new Error('Lokasi tujuan bukan rak penyimpanan (RACK).') as Error & { statusCode: number };
            error.statusCode = 400;
            throw error;
          }

          await client.query(
            `UPDATE boxes SET location_id = $1, status = 'IN_RACK' WHERE id = $2`,
            [destRack.id, box.id]
          );

          await client.query(
            `INSERT INTO stock_movements (
              id, tx_code, movement_type, product_id, sku, from_location, to_location,
              qty_change, qty_label, reference_doc, performed_by_name, from_location_id, to_location_id, created_at
            ) VALUES ($1, $2, 'PUTAWAY', $3, $4, $5, $6, 0, $7, $8, 'Operator Gudang', $9, $10, NOW())`,
            [
              randomUUID(),
              `BOX-PUT-${Date.now().toString().slice(-6)}`,
              box.product_id,
              box.sku,
              box.current_loc_code ? `${box.current_loc_code} - ${box.current_loc_name}` : 'Staging Inbound (INB01)',
              `${destRack.code} - ${destRack.name}`,
              `${box.qty_per_box} unit (1 Box ditempatkan di rak)`,
              box.box_code,
              box.location_id || null,
              destRack.id,
            ]
          );

          await client.query('COMMIT');
          transactionStarted = false;

          publishRealtimeEvent('wms/stock/realtime', {
            event: 'BOX_PUTAWAY_COMPLETED',
            box_code: box.box_code,
            epc: box.master_epc,
            sku: box.sku,
            to_location: destRack.code,
          });

          return reply.code(201).send({
            success: true,
            message: `Box ${box.box_code} (${box.qty_per_box} unit ${box.product_name}) berhasil ditempatkan di rak ${destRack.code}.`,
            data: {
              epc: box.master_epc,
              box_code: box.box_code,
              sku: box.sku,
              product_name: box.product_name,
              to_location: destRack.code,
              item_status: 'IN_RACK',
              tag_status: 'IN_RACK',
            },
          });
        }

        const error = new Error(
          'RFID atau Kode Box tidak ditemukan atau belum terhubung dengan item dan produk.'
        ) as Error & { statusCode: number };
        error.statusCode = 404;
        throw error;
      }

      const item = itemResult.rows[0];

      // 2. Putaway hanya menerima item dan tag berstatus ENCODED.
      if (item.tag_status !== 'ENCODED' || item.item_status !== 'ENCODED') {
        const error = new Error(
          `Putaway ditolak. Status tag: ${item.tag_status}; status item: ${item.item_status}. Keduanya harus ENCODED.`
        ) as Error & { statusCode: number };
        error.statusCode = 409;
        throw error;
      }

      // 3. Kunci lokasi transit INB01 dan lokasi rak tujuan.
      // Penguncian berdasarkan ID menjaga urutan lock tetap konsisten.
      const locationsResult = await client.query(
        `
        SELECT
          id,
          code,
          zone_code,
          name,
          max_capacity,
          current_items_count,
          capacity_status,
          location_type
        FROM locations
        WHERE code IN ('INB01', $1)
        ORDER BY id
        FOR UPDATE
        `,
        [location_code.trim().toUpperCase()]
      );

      const sourceLocation = locationsResult.rows.find(
        (location: { code: string }) => location.code === 'INB01'
      );
      const destinationLocation = locationsResult.rows.find(
        (location: { code: string }) =>
          location.code === location_code.trim().toUpperCase()
      );

      if (!sourceLocation) {
        const error = new Error('Lokasi transit INB01 tidak ditemukan.') as Error & {
          statusCode: number;
        };
        error.statusCode = 500;
        throw error;
      }

      if (!destinationLocation) {
        const error = new Error('Lokasi rak tujuan tidak ditemukan.') as Error & {
          statusCode: number;
        };
        error.statusCode = 404;
        throw error;
      }

      if (sourceLocation.location_type !== 'TRANSIT') {
        throw new Error('Lokasi INB01 tidak memiliki tipe TRANSIT.');
      }

      if (destinationLocation.location_type !== 'RACK') {
        const error = new Error(
          'Lokasi tujuan bukan rak penyimpanan (RACK).'
        ) as Error & { statusCode: number };
        error.statusCode = 400;
        throw error;
      }

      if (sourceLocation.id === destinationLocation.id) {
        const error = new Error(
          'Lokasi transit tidak dapat menjadi lokasi tujuan Putaway.'
        ) as Error & { statusCode: number };
        error.statusCode = 400;
        throw error;
      }

      // 4. Terima item yang sudah berada di INB01 maupun item baru hasil encoding meja Orang 1 (location_id === null).
      const isFromTransit = item.location_id === sourceLocation.id;
      const isFromEncodingDesk = item.location_id === null;

      if (!isFromTransit && !isFromEncodingDesk) {
        const error = new Error(
          'Lokasi asal item bukan INB01 atau Meja Tagging. Putaway hanya menerima item ENCODED baru atau dari lokasi transit INB01.'
        ) as Error & { statusCode: number };
        error.statusCode = 409;
        throw error;
      }

      // 5. Validasi kapasitas lokasi sumber (jika dari INB01) dan rak tujuan.
      const sourceCount = Number(sourceLocation.current_items_count ?? 0);
      const destinationCount = Number(destinationLocation.current_items_count ?? 0);
      const destinationCapacity = Number(destinationLocation.max_capacity ?? 0);

      if (isFromTransit && sourceCount <= 0) {
        const error = new Error(
          'Jumlah item INB01 tidak mencukupi. Periksa sinkronisasi kapasitas lokasi transit.'
        ) as Error & { statusCode: number };
        error.statusCode = 409;
        throw error;
      }

      if (destinationCapacity <= 0 || destinationCount >= destinationCapacity) {
        const error = new Error(
          'Rak tujuan penuh atau kapasitas rak belum diatur. Silakan pilih lokasi lain.'
        ) as Error & { statusCode: number };
        error.statusCode = 409;
        throw error;
      }

      // 6. Pindahkan item dari INB01 / Meja Tagging ke rak tujuan.
      const updateItemResult = await client.query(
        `
        UPDATE items
        SET
          location_id = $1,
          status = 'IN_STOCK',
          putaway_at = NOW(),
          updated_at = NOW()
        WHERE id = $2
          AND (location_id = $3 OR location_id IS NULL)
          AND status = 'ENCODED'
        RETURNING *
        `,
        [destinationLocation.id, item.item_id, sourceLocation.id]
      );

      if (updateItemResult.rows.length === 0) {
        const error = new Error(
          'Item gagal dipindahkan. Status atau lokasi item telah berubah.'
        ) as Error & { statusCode: number };
        error.statusCode = 409;
        throw error;
      }

      // 7. Ubah status tag RFID menjadi IN_STOCK.
      const updateTagResult = await client.query(
        `
        UPDATE tags
        SET
          status = 'IN_STOCK',
          updated_at = NOW()
        WHERE id = $1
          AND status = 'ENCODED'
        RETURNING id
        `,
        [item.tag_id]
      );

      if (updateTagResult.rows.length === 0) {
        const error = new Error(
          'Status tag berubah atau tag tidak dapat diperbarui.'
        ) as Error & { statusCode: number };
        error.statusCode = 409;
        throw error;
      }

      // 8. Kapasitas lokasi diperbarui otomatis oleh trigger PostgreSQL.
      // Jangan melakukan UPDATE locations secara manual karena
      // trg_refresh_rack_capacity menghitung ulang lokasi asal dan tujuan
      // setelah perubahan items.location_id.

      const refreshedLocations = await client.query(
        `
        SELECT
          id,
          code,
          name,
          location_type,
          current_items_count,
          max_capacity,
          capacity_status
        FROM locations
        WHERE id = ANY($1::UUID[])
        `,
        [[sourceLocation.id, destinationLocation.id]]
      );

      const updatedSource = refreshedLocations.rows.find(
        (location: { id: string }) => location.id === sourceLocation.id
      );

      const updatedDestination = refreshedLocations.rows.find(
        (location: { id: string }) => location.id === destinationLocation.id
      );

      if (!updatedSource || !updatedDestination) {
        throw new Error(
          'Gagal membaca kapasitas lokasi setelah proses Putaway.'
        );
      }

      // 10. Buat satu ID perpindahan dengan dua kode transaksi unik.
      const transferId = randomUUID().replace(/-/g, '');
      const txOut = `PUT-OUT-${transferId}`;
      const txIn = `PUT-IN-${transferId}`;

      // 11. Catat pengeluaran item dari INB01 (-1) hanya jika item sebelumnya sudah dibukukan di INB01.
      let ledgerOutRow = null;
      if (isFromTransit) {
        const ledgerOutResult = await client.query(
          `
          INSERT INTO stock_movements (
            tx_code,
            movement_type,
            product_id,
            sku,
            tag_id,
            from_location,
            to_location,
            qty_change,
            qty_label,
            reference_doc,
            performed_by_name,
            from_location_id,
            to_location_id
          )
          VALUES (
            $1,
            'PUTAWAY_OUT',
            $2,
            $3,
            $4,
            $5,
            'Proses Putaway',
            -1,
            '-1 unit',
            $6,
            'System',
            $7,
            NULL
          )
          RETURNING *
          `,
          [
            txOut,
            item.product_id,
            item.sku,
            item.tag_id,
            sourceLocation.name,
            reference_doc.trim(),
            sourceLocation.id,
          ]
        );
        ledgerOutRow = ledgerOutResult.rows[0];
      }

      // 12. Catat penerimaan item pada rak tujuan (+1).
      const ledgerInResult = await client.query(
        `
        INSERT INTO stock_movements (
          tx_code,
          movement_type,
          product_id,
          sku,
          tag_id,
          from_location,
          to_location,
          qty_change,
          qty_label,
          reference_doc,
          performed_by_name,
          from_location_id,
          to_location_id
        )
        VALUES (
          $1,
          'PUTAWAY_IN',
          $2,
          $3,
          $4,
          $5,
          $6,
          1,
          '+1 unit',
          $7,
          'System',
          $8,
          $9
        )
        RETURNING *
        `,
        [
          txIn,
          item.product_id,
          item.sku,
          item.tag_id,
          isFromTransit ? 'Proses Putaway' : sourceLocation.name,
          destinationLocation.name,
          reference_doc.trim(),
          isFromTransit ? null : sourceLocation.id,
          destinationLocation.id,
        ]
      );

      // 13. Commit seluruh perubahan secara atomik.
      await client.query('COMMIT');
      transactionStarted = false;

      // 14. Ambil ringkasan stok setelah commit.
      type StockRow =
        Awaited<ReturnType<typeof getAggregatedStockByProduct>>[number];
      let currentStock: StockRow | null = null;

      try {
        const stockData = await getAggregatedStockByProduct();
        currentStock = stockData.find(
          (stock) => stock.sku === item.sku
        ) || null;
      } catch (stockError) {
        app.log.error(
          stockError,
          'Gagal mengambil kalkulasi stok setelah Putaway'
        );
      }

      // 15. Kirim MQTT setelah transaksi database berhasil di-commit.
      try {
        publishRealtimeEvent('wms/stock/realtime', {
          event: 'PUTAWAY_COMPLETED',
          epc: item.epc,
          sku: item.sku,
          source_location_code: updatedSource.code,
          destination_location_code: updatedDestination.code,
          destination_location_name: updatedDestination.name,
          item: updateItemResult.rows[0],
          ledger: {
            outgoing: ledgerOutRow,
            incoming: ledgerInResult.rows[0],
          },
          source_location: updatedSource,
          destination_location: updatedDestination,
          currentStock,
        });
      } catch (mqttError) {
        app.log.error(mqttError, 'PUTAWAY MQTT ERROR');
      }

      return reply.code(201).send({
        success: true,
        message: 'Putaway berhasil. Barang dipindahkan dari INB01 ke rak.',
        data: {
          epc: item.epc,
          sku: item.sku,
          product_name: item.product_name,
          source_location_code: updatedSource.code,
          destination_location_code: updatedDestination.code,
          destination_location_name: updatedDestination.name,
          item_status: 'IN_STOCK',
          tag_status: 'IN_STOCK',
          putaway_at: updateItemResult.rows[0].putaway_at,
          source_location: updatedSource,
          destination_location: updatedDestination,
          ledger: {
            outgoing: ledgerOutRow,
            incoming: ledgerInResult.rows[0],
          },
          currentStock,
        },
      });
    } catch (err) {
      if (transactionStarted && client) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          app.log.error(rollbackError, 'PUTAWAY ROLLBACK ERROR');
        }
      }

      const error = err as Error & {
        statusCode?: number;
        code?: string;
      };

      if (error.code === 'P0001') {
        return reply.code(409).send({
          success: false,
          message: error.message,
        });
      }

      if (error.statusCode) {
        return reply.code(error.statusCode).send({
          success: false,
          message: error.message,
        });
      }

      app.log.error(error, 'PUTAWAY ERROR');
      return reply.code(500).send({
        success: false,
        message: 'Terjadi kesalahan saat memproses Putaway.',
        error: error.message,
        code: error.code,
      });
    } finally {
      if (client) {
        try {
          client.release();
        } catch {
          // Abaikan error release saat socket terputus
        }
      }
    }
  });
}
