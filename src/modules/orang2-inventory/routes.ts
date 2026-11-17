
import { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';

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
        SELECT
          l.id,
          l.code,
          l.zone_code,
          l.name,
          l.max_capacity,
          l.current_items_count,
          CASE
            WHEN COALESCE(l.max_capacity, 0) <= 0 THEN 'Padat'
            WHEN COALESCE(l.current_items_count, 0)::NUMERIC
                 / l.max_capacity * 100 < 50 THEN 'Longgar'
            WHEN COALESCE(l.current_items_count, 0)::NUMERIC
                 / l.max_capacity * 100 <= 85 THEN 'Optimal'
            ELSE 'Padat'
          END AS capacity_status,
          l.location_type
        FROM locations l
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
                PARTITION BY COALESCE(sm.product_id::TEXT, sm.sku)
                ORDER BY sm.created_at ASC, sm.id ASC
                ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
              ) AS running_balance
            FROM stock_movements sm
            LEFT JOIN products p ON sm.product_id = p.id
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
  // Struktur disesuaikan dengan tabel Supabase yang aktif.
  // Trigger PostgreSQL menangani validasi dan pembaruan kapasitas rak.
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

    // 1. Validasi input
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
      await client.query('BEGIN');
      transactionStarted = true;

      // 2. Ambil dan kunci data tag, item, dan produk.
      // INNER JOIN memastikan EPC sudah terhubung dengan item dan produk.
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
        const error = new Error(
          'RFID tidak ditemukan atau belum terhubung dengan item dan produk.'
        ) as Error & { statusCode: number };
        error.statusCode = 404;
        throw error;
      }

      const item = itemResult.rows[0];

      // 3. Putaway hanya untuk tag dan item berstatus ENCODED.
      if (item.tag_status !== 'ENCODED' || item.item_status !== 'ENCODED') {
        const error = new Error(
          `Putaway ditolak. Status tag: ${item.tag_status}; status item: ${item.item_status}. Keduanya harus ENCODED.`
        ) as Error & { statusCode: number };
        error.statusCode = 409;
        throw error;
      }

      // 4. Item harus belum memiliki lokasi.
      if (item.location_id !== null) {
        const error = new Error(
          'Barang sudah memiliki lokasi penyimpanan.'
        ) as Error & { statusCode: number };
        error.statusCode = 409;
        throw error;
      }

      // 5. Ambil dan kunci lokasi tujuan berdasarkan locations.code.
      const locationResult = await client.query(
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
        WHERE code = $1
        FOR UPDATE
        `,
        [location_code.trim().toUpperCase()]
      );

      if (locationResult.rows.length === 0) {
        const error = new Error('Lokasi rak tidak ditemukan.') as Error & {
          statusCode: number;
        };
        error.statusCode = 404;
        throw error;
      }

      const location = locationResult.rows[0];

      if (location.location_type !== 'RACK') {
        const error = new Error(
          'Lokasi tujuan bukan rak penyimpanan (RACK).'
        ) as Error & { statusCode: number };
        error.statusCode = 400;
        throw error;
      }

      // 6. Tempatkan item pada rak.
      // BEFORE/AFTER trigger items akan memvalidasi kapasitas dan
      // memperbarui current_items_count serta capacity_status.
      const updateItemResult = await client.query(
        `
        UPDATE items
        SET
          location_id = $1,
          status = 'IN_STOCK',
          putaway_at = NOW(),
          updated_at = NOW()
        WHERE id = $2
          AND location_id IS NULL
          AND status = 'ENCODED'
        RETURNING *
        `,
        [location.id, item.item_id]
      );

      if (updateItemResult.rows.length === 0) {
        const error = new Error(
          'Item tidak dapat dipindahkan. Periksa kembali status dan lokasi item.'
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

      // 8. Catat transaksi ke stock_movements.
      const ledgerResult = await client.query(
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
          'PUT-' || REPLACE(gen_random_uuid()::TEXT, '-', ''),
          'PUTAWAY',
          $1,
          $2,
          $3,
          'Inbound / Meja Tagging',
          $4,
          1,
          '1 unit',
          $5,
          'System',
          NULL,
          $6
        )
        RETURNING *
        `,
        [
          item.product_id,
          item.sku,
          item.tag_id,
          location.name,
          reference_doc.trim(),
          location.id,
        ]
      );

      // 9. Commit seluruh perubahan secara atomik.
      await client.query('COMMIT');
      transactionStarted = false;

      // 10. Baca kondisi rak terbaru setelah trigger database berjalan.
      const updatedLocationResult = await db.query(
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
        WHERE id = $1
        `,
        [location.id]
      );

      const updatedLocation = updatedLocationResult.rows[0] ?? location;

      // 11. Ambil ringkasan stok untuk respons dan event realtime.
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

      // 12. Kirim MQTT setelah transaksi database berhasil di-commit.
      try {
        publishRealtimeEvent('wms/stock/realtime', {
          event: 'PUTAWAY_COMPLETED',
          epc: item.epc,
          sku: item.sku,
          location_code: updatedLocation.code,
          location_name: updatedLocation.name,
          item: updateItemResult.rows[0],
          ledgerEntry: ledgerResult.rows[0],
          location: updatedLocation,
          currentStock,
        });
      } catch (mqttError) {
        app.log.error(mqttError, 'PUTAWAY MQTT ERROR');
      }

      return reply.code(201).send({
        success: true,
        message: 'Putaway berhasil. Barang sudah ditempatkan di rak.',
        data: {
          epc: item.epc,
          sku: item.sku,
          product_name: item.product_name,
          location_code: updatedLocation.code,
          location_name: updatedLocation.name,
          item_status: 'IN_STOCK',
          tag_status: 'IN_STOCK',
          putaway_at: updateItemResult.rows[0].putaway_at,
          location: updatedLocation,
          ledger: ledgerResult.rows[0],
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

      // Trigger kapasitas rak biasanya melempar P0001.
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
      client?.release();
    }
  });
}
