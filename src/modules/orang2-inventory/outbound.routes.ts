import { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { randomUUID } from 'crypto';

import { db, isPostgresConnected } from '../../config/db';
import { publishRealtimeEvent } from '../../config/mqtt';
import { getAggregatedStockByProduct } from './stock.service';

type OutboundBody = {
  invoice_or_resi?: string;
  customer_or_destination?: string;
  courier?: string;
  epcs?: string[];
  total_amount?: number;
};

export async function outboundRoutes(app: FastifyInstance) {

  // ==========================================
  // GET DAFTAR PICKING & PACKING
  // ==========================================
  app.get('/api/outbound/picking-orders', async (request, reply) => {
    try {
      if (!isPostgresConnected) {
        return reply.code(503).send({
          success: false,
          message: 'Database PostgreSQL belum terhubung.',
        });
      }

      const result = await db.query(`
        WITH legacy_orders AS (
          SELECT
            po.id,
            po.order_number,
            po.destination,
            po.courier,
            po.status,
            po.total_items,
            po.scanned_items,
            po.created_at,
            po.updated_at,
            COALESCE(
              json_agg(
                json_build_object(
                  'id', pi.id,
                  'epc', pi.epc,
                  'sku', pi.sku,
                  'item_id', pi.item_id,
                  'product_id', pi.product_id,
                  'product_name', p.name,
                  'location_id', pi.location_id,
                  'location_code', l.code,
                  'location_name', l.name,
                  'is_scanned', pi.is_scanned,
                  'scanned_at', pi.scanned_at
                )
                ORDER BY pi.epc
              ) FILTER (WHERE pi.id IS NOT NULL),
              '[]'::json
            ) AS items
          FROM outbound_picking_orders po
          LEFT JOIN outbound_picking_items pi ON pi.order_id = po.id
          LEFT JOIN products p ON p.id = pi.product_id
          LEFT JOIN locations l ON l.id = pi.location_id
          GROUP BY po.id
        ),
        orang1_orders AS (
          SELECT
            o.id,
            o.order_number,
            COALESCE(pack.status, o.status) AS destination,
            'JNE Express'::text AS courier,
            CASE
              WHEN o.status = 'SIAP_PACKING'
                AND EXISTS (
                  SELECT 1 FROM public.picking_scans ps2
                  WHERE ps2.order_id = o.id AND ps2.released_at IS NULL
                )
                AND NOT EXISTS (
                  SELECT 1 FROM public.picking_scans ps2
                  JOIN public.items it2 ON it2.id = ps2.item_id
                  WHERE ps2.order_id = o.id AND ps2.released_at IS NULL
                    AND it2.status NOT IN ('AUTHORIZED_OUT', 'EXITED')
                ) THEN 'DIKIRIM'
              WHEN pack.status = 'SELESAI_PACKING' THEN 'SELESAI_PACKING'
              ELSE o.status
            END AS status,
            COUNT(ps.id)::int AS total_items,
            COUNT(ps.id)::int AS scanned_items,
            o.created_at,
            o.updated_at,
            COALESCE(
              json_agg(
                json_build_object(
                  'id', ps.id,
                  'epc', ps.epc,
                  'sku', p.sku,
                  'item_id', ps.item_id,
                  'product_id', ps.product_id,
                  'product_name', p.name,
                  'location_id', ps.location_id,
                  'location_code', ps.location_code,
                  'location_name', ps.location_name,
                  'is_scanned', TRUE,
                  'scanned_at', ps.scanned_at
                )
                ORDER BY ps.epc
              ) FILTER (WHERE ps.id IS NOT NULL),
              '[]'::json
            ) AS items
          FROM public.picking_orders o
          LEFT JOIN public.picking_packing pack ON pack.order_id = o.id
          LEFT JOIN public.picking_scans ps ON ps.order_id = o.id AND ps.released_at IS NULL
          LEFT JOIN public.products p ON p.id = ps.product_id
          GROUP BY o.id, pack.status
        )
        SELECT * FROM orang1_orders
        UNION ALL
        SELECT * FROM legacy_orders
        ORDER BY created_at DESC
      `);

      return reply.send({
        success: true,
        total: result.rows.length,
        data: result.rows,
      });
    } catch (error) {
      request.log.error(error, 'GET PICKING ORDERS ERROR');
      return reply.code(500).send({
        success: false,
        message: 'Gagal mengambil daftar picking.',
      });
    }
  });

  // ==========================================
  // POST MEMBUAT PESANAN PICKING
  // ==========================================
  app.post('/api/outbound/picking-orders', async (request, reply) => {
    const body = (request.body ?? {}) as {
      order_number?: string;
      destination?: string;
      courier?: string;
      epcs?: string[];
    };

    if (
      typeof body.order_number !== 'string' ||
      typeof body.destination !== 'string' ||
      (body.courier !== undefined &&
        body.courier !== null &&
        typeof body.courier !== 'string') ||
      !Array.isArray(body.epcs) ||
      body.epcs.length === 0 ||
      body.epcs.some((epc) => typeof epc !== 'string' || !epc.trim())
    ) {
      return reply.code(400).send({
        success: false,
        message: 'Nomor pesanan, tujuan, dan minimal satu EPC wajib diisi.',
      });
    }

    const orderNumber = body.order_number.trim();
    const destination = body.destination.trim();
    const courier = body.courier?.trim() || null;
    const epcs = body.epcs.map((epc) => epc.trim());

    if (!orderNumber || !destination) {
      return reply.code(400).send({
        success: false,
        message: 'Nomor pesanan dan tujuan tidak boleh kosong.',
      });
    }

    if (new Set(epcs).size !== epcs.length) {
      return reply.code(400).send({
        success: false,
        message: 'Terdapat EPC duplikat dalam pesanan.',
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

      const itemResult = await client.query(
        `
          SELECT
            t.id AS tag_id,
            t.epc,
            t.status AS tag_status,
            i.id AS item_id,
            i.status AS item_status,
            i.product_id,
            i.location_id,
            p.sku,
            p.name AS product_name,
            l.code AS location_code,
            l.name AS location_name,
            l.location_type
          FROM public.tags t
            INNER JOIN public.items i ON i.tag_id = t.id
            INNER JOIN public.products p ON p.id = i.product_id
            LEFT JOIN public.locations l ON l.id = i.location_id
          WHERE t.epc = ANY($1::text[])
          ORDER BY t.epc
          FOR UPDATE OF t, i
        `,
        [epcs]
      );

      if (itemResult.rows.length !== epcs.length) {
        const foundEpcs = itemResult.rows.map((item: any) => item.epc);
        const missingEpcs = epcs.filter(
          (epc) => !foundEpcs.some(
            (foundEpc: string) =>
              foundEpc.trim().toUpperCase() === epc.trim().toUpperCase()
          )
        );

        request.log.warn(
          {
            requested_epcs: epcs,
            found_epcs: foundEpcs,
            missing_epcs: missingEpcs,
          },
          'PICKING EPC VALIDATION MISMATCH'
        );

        return reply.code(404).send({
          success: false,
          message:
            'Sebagian EPC tidak ditemukan atau relasi item/produk tidak lengkap.',
          requested_epcs: epcs,
          found_epcs: foundEpcs,
          missing_epcs: missingEpcs,
        });
      }

      for (const item of itemResult.rows) {
        if (
          item.tag_status !== 'IN_STOCK' ||
          item.item_status !== 'IN_STOCK'
        ) {
          const error = new Error(
            `EPC ${item.epc} tidak tersedia. Status tag/item harus IN_STOCK.`
          ) as Error & { statusCode: number };
          error.statusCode = 409;
          throw error;
        }

        if (!item.location_id || item.location_type !== 'RACK') {
          const error = new Error(
            `EPC ${item.epc} belum berada pada rak penyimpanan yang valid.`
          ) as Error & { statusCode: number };
          error.statusCode = 409;
          throw error;
        }
      }

      const orderResult = await client.query(
        `
          INSERT INTO outbound_picking_orders (
            order_number,
            destination,
            courier,
            status,
            total_items,
            scanned_items
          )
          VALUES ($1, $2, $3, 'MENUNGGU_PICKING', $4, 0)
          RETURNING *
        `,
        [orderNumber, destination, courier, itemResult.rows.length]
      );

      const order = orderResult.rows[0];

      for (const item of itemResult.rows) {
        await client.query(
          `
            INSERT INTO outbound_picking_items (
              order_id,
              item_id,
              tag_id,
              product_id,
              location_id,
              epc,
              sku
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7)
          `,
          [
            order.id,
            item.item_id,
            item.tag_id,
            item.product_id,
            item.location_id,
            item.epc,
            item.sku,
          ]
        );

        const itemUpdate = await client.query(
          `
            UPDATE items
            SET status = 'RESERVED', updated_at = NOW()
            WHERE id = $1 AND status = 'IN_STOCK'
            RETURNING id
          `,
          [item.item_id]
        );

        const tagUpdate = await client.query(
          `
            UPDATE tags
            SET status = 'RESERVED', updated_at = NOW()
            WHERE id = $1 AND status = 'IN_STOCK'
            RETURNING id
          `,
          [item.tag_id]
        );

        if (itemUpdate.rows.length !== 1 || tagUpdate.rows.length !== 1) {
          throw new Error(`Gagal melakukan reservasi EPC ${item.epc}.`);
        }
      }

      await client.query('COMMIT');
      transactionStarted = false;

      return reply.code(201).send({
        success: true,
        message: 'Pesanan picking berhasil dibuat.',
        data: {
          ...order,
          items: itemResult.rows.map((item: any) => ({
            epc: item.epc,
            sku: item.sku,
            product_name: item.product_name,
            location_code: item.location_code,
            location_name: item.location_name,
            is_scanned: false,
          })),
        },
      });
    } catch (err) {
      if (transactionStarted && client) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          request.log.error(rollbackError, 'CREATE PICKING ROLLBACK ERROR');
        }
      }

      const error = err as Error & { statusCode?: number; code?: string };

      if (error.code === '23505') {
        return reply.code(409).send({
          success: false,
          message: 'Nomor pesanan sudah digunakan.',
        });
      }

      if (error.statusCode) {
        return reply.code(error.statusCode).send({
          success: false,
          message: error.message,
        });
      }

      request.log.error(error, 'CREATE PICKING ORDER ERROR');
      return reply.code(500).send({
        success: false,
        message: 'Gagal membuat pesanan picking.',
        error: error.message,
      });
    } finally {
      client?.release();
    }
  });

  // ==========================================
  // PATCH MULAI PROSES PICKING
  // ==========================================
  app.patch('/api/outbound/picking-orders/:id/status', async (request, reply) => {
    const { id } = request.params as { id: string };

    if (!isPostgresConnected) {
      return reply.code(503).send({
        success: false,
        message: 'Database PostgreSQL belum terhubung.',
      });
    }

    try {
      const result = await db.query(
        `
          UPDATE outbound_picking_orders
          SET status = 'SEDANG_DIAMBIL',
              updated_at = NOW()
          WHERE id = $1
            AND status = 'MENUNGGU_PICKING'
          RETURNING *
        `,
        [id]
      );

      if (result.rows.length === 0) {
        return reply.code(409).send({
          success: false,
          message: 'Pesanan tidak ditemukan atau tidak dapat dimulai.',
        });
      }

      return reply.send({
        success: true,
        message: 'Proses picking berhasil dimulai.',
        data: result.rows[0],
      });
    } catch (error) {
      request.log.error(error, 'START PICKING ERROR');
      return reply.code(500).send({
        success: false,
        message: 'Gagal memulai proses picking.',
      });
    }
  });

  // ==========================================
  // POST SCAN RFID / BARCODE PICKING
  // ==========================================
  app.post('/api/outbound/picking-orders/:id/scan', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { epc?: string };
    const epc = body.epc?.trim();

    if (!epc) {
      return reply.code(400).send({
        success: false,
        message: 'EPC wajib diisi.',
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

      const orderResult = await client.query(
        `
          SELECT *
          FROM outbound_picking_orders
          WHERE id = $1
          FOR UPDATE
        `,
        [id]
      );

      if (orderResult.rows.length === 0) {
        const error = new Error('Pesanan picking tidak ditemukan.') as Error & {
          statusCode: number;
        };
        error.statusCode = 404;
        throw error;
      }

      const order = orderResult.rows[0];

      if (order.status !== 'SEDANG_DIAMBIL') {
        const error = new Error(
          'Pesanan harus berstatus SEDANG_DIAMBIL sebelum scan.'
        ) as Error & { statusCode: number };
        error.statusCode = 409;
        throw error;
      }

      const itemResult = await client.query(
        `
          SELECT
            pi.id,
            pi.epc,
            pi.sku,
            pi.is_scanned,
            pi.item_id,
            pi.tag_id,
            i.status AS item_status,
            t.status AS tag_status
          FROM outbound_picking_items pi
          INNER JOIN items i ON i.id = pi.item_id
          INNER JOIN tags t ON t.id = pi.tag_id
          WHERE pi.order_id = $1
            AND pi.epc = $2
          FOR UPDATE OF pi, i, t
        `,
        [id, epc]
      );

      if (itemResult.rows.length === 0) {
        const error = new Error(
          `EPC ${epc} tidak terdaftar pada pesanan ini.`
        ) as Error & { statusCode: number };
        error.statusCode = 404;
        throw error;
      }

      const pickedItem = itemResult.rows[0];

      if (pickedItem.is_scanned) {
        const error = new Error(`EPC ${epc} sudah pernah dipindai.`) as Error & {
          statusCode: number;
        };
        error.statusCode = 409;
        throw error;
      }

      if (
        pickedItem.item_status !== 'RESERVED' ||
        pickedItem.tag_status !== 'RESERVED'
      ) {
        const error = new Error(
          `Status barang EPC ${epc} tidak sesuai dengan proses picking.`
        ) as Error & { statusCode: number };
        error.statusCode = 409;
        throw error;
      }

      await client.query(
        `
          UPDATE outbound_picking_items
          SET is_scanned = TRUE,
              scanned_at = NOW()
          WHERE id = $1
        `,
        [pickedItem.id]
      );

      const countResult = await client.query(
        `
          SELECT COUNT(*)::INTEGER AS scanned_count
          FROM outbound_picking_items
          WHERE order_id = $1 AND is_scanned = TRUE
        `,
        [id]
      );

      const scannedCount = countResult.rows[0].scanned_count;
      const allScanned = scannedCount === order.total_items;
      const nextStatus = allScanned ? 'SIAP_PACKING' : 'SEDANG_DIAMBIL';

      const updatedOrder = await client.query(
        `
          UPDATE outbound_picking_orders
          SET scanned_items = $2,
              status = $3,
              updated_at = NOW()
          WHERE id = $1
          RETURNING *
        `,
        [id, scannedCount, nextStatus]
      );

      await client.query('COMMIT');
      transactionStarted = false;

      return reply.send({
        success: true,
        message: allScanned
          ? 'Semua barang berhasil dipindai. Pesanan siap packing.'
          : 'Scan EPC berhasil.',
        data: {
          order: updatedOrder.rows[0],
          scanned_epc: epc,
          total_items: order.total_items,
          scanned_items: scannedCount,
          remaining_items: order.total_items - scannedCount,
          status: nextStatus,
        },
      });
    } catch (err) {
      if (transactionStarted && client) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          request.log.error(rollbackError, 'PICKING SCAN ROLLBACK ERROR');
        }
      }

      const error = err as Error & { statusCode?: number };
      if (error.statusCode) {
        return reply.code(error.statusCode).send({
          success: false,
          message: error.message,
        });
      }

      request.log.error(error, 'PICKING SCAN ERROR');
      return reply.code(500).send({
        success: false,
        message: 'Gagal memproses scan EPC.',
        error: error.message,
      });
    } finally {
      client?.release();
    }
  });


  // ==========================================
  // GET RIWAYAT PENGIRIMAN OUTBOUND
  // ==========================================
  app.get('/api/outbound/shipments', async (request, reply) => {
    try {
      if (!isPostgresConnected) {
        return reply.code(503).send({
          success: false,
          message: 'Database PostgreSQL belum terhubung.',
        });
      }

      const result = await db.query(
        `
        SELECT
          s.id,
          s.invoice_or_resi,
          s.order_type,
          s.customer_or_destination,
          s.courier,
          s.total_items,
          s.total_amount,
          s.payment_status,
          s.shipping_status,
          s.created_at,
          gp.pass_code AS gate_pass_number,
          gp.status AS gate_pass_status,
          (gp.status = 'ACTIVE') AS gate_pass_valid,
          gp.created_at AS gate_pass_issued_at,
          shipment_items.items
        FROM sales s
        LEFT JOIN LATERAL (
          SELECT
            COALESCE(
              to_jsonb(gp)->>'pass_code',
              to_jsonb(gp)->>'pass_number'
            ) AS pass_code,
            COALESCE(
              to_jsonb(gp)->>'status',
              CASE
                WHEN LOWER(COALESCE(to_jsonb(gp)->>'is_valid', 'false')) = 'true'
                  THEN 'ACTIVE'
                ELSE 'REVOKED'
              END
            ) AS status,
            NULLIF(to_jsonb(gp)->>'created_at', '')::timestamptz AS created_at
          FROM public.gate_passes gp
          WHERE
            COALESCE(to_jsonb(gp)->>'sale_id', '') = s.id::text
            OR COALESCE(to_jsonb(gp)->>'reference_resi', '') = s.invoice_or_resi
            OR COALESCE(to_jsonb(gp)->>'reference_doc', '') = s.invoice_or_resi
          ORDER BY
            NULLIF(to_jsonb(gp)->>'created_at', '')::timestamptz DESC NULLS LAST
          LIMIT 1
        ) gp ON TRUE
        LEFT JOIN LATERAL (
          SELECT COALESCE(
            json_agg(
              json_build_object(
                'epc', t.epc,
                'sku', sm.sku,
                'product_name', p.name,
                'qty', ABS(sm.qty_change)
              ) ORDER BY sm.created_at
            ),
            '[]'::json
          ) AS items
          FROM stock_movements sm
          LEFT JOIN tags t ON t.id = sm.tag_id
          LEFT JOIN products p ON p.id = sm.product_id
          WHERE sm.movement_type = 'OUTBOUND_SHIPMENT'
            AND sm.reference_doc = s.invoice_or_resi
        ) shipment_items ON TRUE
        WHERE s.order_type = 'OUTBOUND_SHIPMENT'
        ORDER BY s.created_at DESC
        `
      );

      return reply.send({
        success: true,
        total: result.rows.length,
        data: result.rows,
      });
    } catch (error) {
  console.error('DETAIL ERROR GET OUTBOUND SHIPMENTS:', error);
  request.log.error(error, 'GET OUTBOUND SHIPMENTS ERROR');

  return reply.code(500).send({
    success: false,
    message: 'Gagal mengambil riwayat pengiriman.',
    error: error instanceof Error ? error.message : String(error),
  });
  }
  });

  // ==========================================
  // POST OTORISASI BARANG KELUAR
  // ==========================================
  app.post('/api/outbound/authorize', async (request, reply) => {
    const body = (request.body ?? {}) as { epcs?: string[] };
    const epcs = body.epcs;

    if (
      !Array.isArray(epcs) ||
      epcs.length === 0 ||
      epcs.some((epc) => typeof epc !== 'string' || !epc.trim())
    ) {
      return reply.code(400).send({
        success: false,
        message: 'epcs wajib berupa array berisi minimal satu EPC yang valid.',
      });
    }

    const normalizedEpcs = epcs.map((epc) => epc.trim());
    if (new Set(normalizedEpcs).size !== normalizedEpcs.length) {
      return reply.code(400).send({
        success: false,
        message: 'Terdapat EPC duplikat dalam permintaan otorisasi.',
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

      const result = await client.query(
        `
        SELECT
          t.id AS tag_id,
          t.epc,
          t.status AS tag_status,
          i.id AS item_id,
          i.status AS item_status,
          i.location_id,
          p.sku,
          p.name AS product_name,
          l.code AS location_code,
          l.location_type,
          EXISTS (
            SELECT 1
            FROM outbound_picking_items pi
            INNER JOIN outbound_picking_orders po ON po.id = pi.order_id
            WHERE pi.item_id = i.id
              AND pi.is_scanned = TRUE
              AND po.status = 'SIAP_PACKING'
          ) AS picking_ready
        FROM tags t
        INNER JOIN items i ON i.tag_id = t.id
        INNER JOIN products p ON p.id = i.product_id
        LEFT JOIN locations l ON l.id = i.location_id
        WHERE t.epc = ANY($1::text[])
        ORDER BY t.epc
        FOR UPDATE OF t, i
        `,
        [normalizedEpcs]
      );

      if (result.rows.length !== normalizedEpcs.length) {
        const error = new Error('Ada EPC yang tidak ditemukan atau belum terhubung dengan item dan produk.') as Error & { statusCode: number };
        error.statusCode = 404;
        throw error;
      }

      for (const item of result.rows) {
        const isAvailable =
          item.tag_status === 'IN_STOCK' &&
          item.item_status === 'IN_STOCK';

        const isReadyFromPicking =
          item.tag_status === 'RESERVED' &&
          item.item_status === 'RESERVED' &&
          item.picking_ready === true;

        if (!isAvailable && !isReadyFromPicking) {
          const error = new Error(
            `EPC ${item.epc} tidak dapat diotorisasi. Status tag: ${item.tag_status}; status item: ${item.item_status}.`
          ) as Error & { statusCode: number };
          error.statusCode = 409;
          throw error;
        }
        if (!item.location_id || item.location_type !== 'RACK') {
          const error = new Error(`EPC ${item.epc} belum ditempatkan pada rak penyimpanan yang valid.`) as Error & { statusCode: number };
          error.statusCode = 409;
          throw error;
        }
      }

      for (const item of result.rows) {
        const itemUpdate = await client.query(
          `
            UPDATE items
            SET status = 'AUTHORIZED_OUT', updated_at = NOW()
            WHERE id = $1 AND status = $2
            RETURNING id
          `,
          [item.item_id, item.item_status]
        );
        const tagUpdate = await client.query(
          `
            UPDATE tags
            SET status = 'AUTHORIZED_OUT', updated_at = NOW()
            WHERE id = $1 AND status = $2
            RETURNING id
          `,
          [item.tag_id, item.tag_status]
        );

        if (itemUpdate.rows.length !== 1 || tagUpdate.rows.length !== 1) {
          throw new Error(`Gagal mengotorisasi EPC ${item.epc}. Transaksi dibatalkan.`);
        }
      }

      await client.query('COMMIT');
      transactionStarted = false;

      return reply.code(200).send({
        success: true,
        message: 'Otorisasi barang keluar berhasil.',
        total: result.rows.length,
        data: result.rows.map((item: any) => ({
          epc: item.epc,
          sku: item.sku,
          product_name: item.product_name,
          location_code: item.location_code,
          tag_status: 'AUTHORIZED_OUT',
          item_status: 'AUTHORIZED_OUT',
        })),
      });
    } catch (err) {
      if (transactionStarted && client) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          app.log.error(rollbackError, 'OUTBOUND AUTHORIZE ROLLBACK ERROR');
        }
      }

      const error = err as Error & { statusCode?: number };
      if (error.statusCode) {
        return reply.code(error.statusCode).send({ success: false, message: error.message });
      }

      app.log.error(error, 'OUTBOUND AUTHORIZE ERROR');
      return reply.code(500).send({
        success: false,
        message: 'Gagal mengotorisasi barang keluar.',
        error: error.message,
      });
    } finally {
      client?.release();
    }
  });

  // ==========================================
  // POST SIMPAN PENGIRIMAN OUTBOUND
  // ==========================================
  app.post('/api/outbound/shipments', async (request, reply) => {
    const body = (request.body ?? {}) as OutboundBody;

    const epcs = body.epcs;

    // 1. Validasi format data terlebih dahulu.
    if (
      typeof body.invoice_or_resi !== 'string' ||
      typeof body.customer_or_destination !== 'string' ||
      (body.courier !== undefined &&
        body.courier !== null &&
        typeof body.courier !== 'string') ||
      !Array.isArray(epcs) ||
      epcs.length === 0 ||
      epcs.some((epc) => typeof epc !== 'string' || !epc.trim())
    ) {
      return reply.code(400).send({
        success: false,
        message: 'Format data pengiriman tidak valid.',
      });
    }

    const invoice = body.invoice_or_resi.trim();
    const destination = body.customer_or_destination.trim();
    const courier = body.courier?.trim() || null;
    const normalizedEpcs = epcs.map((epc) => epc.trim());

    if (!invoice || !destination) {
      return reply.code(400).send({
        success: false,
        message: 'Nomor resi dan tujuan wajib diisi.',
      });
    }

    // 2. Validasi EPC duplikat.
    if (new Set(normalizedEpcs).size !== normalizedEpcs.length) {
      return reply.code(400).send({
        success: false,
        message: 'Terdapat EPC duplikat dalam satu pengiriman.',
      });
    }

    // 3. Validasi total pembayaran.
    const totalAmount = body.total_amount ?? 0;

    if (
      typeof totalAmount !== 'number' ||
      !Number.isFinite(totalAmount) ||
      totalAmount < 0
    ) {
      return reply.code(400).send({
        success: false,
        message: 'total_amount harus berupa angka minimal 0.',
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

      // 4. Kunci seluruh barang yang akan dikirim.
      const itemResult = await client.query(
        `
        SELECT
          t.id AS tag_id,
          t.epc,
          t.status AS tag_status,
          i.id AS item_id,
          i.status AS item_status,
          i.product_id,
          i.location_id,
          p.sku,
          p.name AS product_name,
          l.name AS location_name
        FROM tags t
        INNER JOIN items i ON i.tag_id = t.id
        INNER JOIN products p ON p.id = i.product_id
        LEFT JOIN locations l ON l.id = i.location_id
        WHERE t.epc = ANY($1::text[])
        ORDER BY t.epc
        FOR UPDATE OF t, i
        `,
        [normalizedEpcs]
      );

      if (itemResult.rows.length !== normalizedEpcs.length) {
        const error = new Error(
          'Ada EPC yang tidak ditemukan atau belum terhubung dengan item dan produk.'
        ) as Error & { statusCode: number };

        error.statusCode = 404;
        throw error;
      }

      // 5. Kunci rak asal agar jumlah isi rak aman dari transaksi bersamaan.
      const locationIds = [
        ...new Set(
          itemResult.rows
            .map((item: any) => item.location_id)
            .filter((id: string | null) => Boolean(id))
        ),
      ].sort();

      if (locationIds.length > 0) {
        await client.query(
          `
          SELECT id
          FROM locations
          WHERE id = ANY($1::uuid[])
          ORDER BY id
          FOR UPDATE
          `,
          [locationIds]
        );
      }

      // 6. Terima barang yang sudah diotorisasi (AUTHORIZED_OUT), sudah di-pick/pack (RESERVED),
      // maupun stok siap kirim dari rak (IN_STOCK), lalu otomatis otorisasi untuk Gate Pass.
      const allowedStatuses = new Set(['AUTHORIZED_OUT', 'RESERVED', 'IN_STOCK']);
      for (const item of itemResult.rows) {
        if (
          !allowedStatuses.has(String(item.tag_status).toUpperCase()) ||
          !allowedStatuses.has(String(item.item_status).toUpperCase())
        ) {
          const error = new Error(
            `EPC ${item.epc} tidak dapat dikirim (status tag: ${item.tag_status}, status item: ${item.item_status}). Barang mungkin sudah keluar (EXITED) atau belum di-putaway.`
          ) as Error & { statusCode: number };

          error.statusCode = 409;
          throw error;
        }
      }

      // 6. Simpan data pengiriman.
      const saleResult = await client.query(
        `
        INSERT INTO sales (
          invoice_or_resi,
          order_type,
          customer_or_destination,
          courier,
          total_items,
          total_amount,
          payment_status,
          shipping_status
        )
        VALUES ($1, 'OUTBOUND_SHIPMENT', $2, $3, $4, $5, 'PAID', 'GATE_PASS_ISSUED')
        RETURNING *
        `,
        [
          invoice,
          destination,
          courier,
          itemResult.rows.length,
          totalAmount,
        ]
      );

      const sale = saleResult.rows[0];

      // Buat Gate Pass otomatis sebagai dokumen pickup ekspedisi (berlaku 24 jam).
      const gatePassNumber = `GP-${randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`;
      const gatePassResult = await client.query(
        `
        INSERT INTO public.gate_passes (
          pass_code,
          sale_id,
          reference_resi,
          status,
          valid_until
        )
        VALUES ($1, $2, $3, 'ACTIVE', NOW() + INTERVAL '24 hours')
        RETURNING *
        `,
        [gatePassNumber, sale.id, invoice]
      );
      const gatePass = gatePassResult.rows[0];

      const ledgerEntries = [];

      // 7. Ubah status barang & tag menjadi AUTHORIZED_OUT (siap scan-out di Gerbang RFID Orang 4)
      // dan catat pengurangan stok ke ledger.
      for (const item of itemResult.rows) {
        const updateItem = await client.query(
          `
          UPDATE items
          SET status = 'AUTHORIZED_OUT',
              updated_at = NOW()
          WHERE id = $1
            AND status IN ('AUTHORIZED_OUT', 'RESERVED', 'IN_STOCK')
          RETURNING id
          `,
          [item.item_id]
        );

        if (updateItem.rows.length === 0) {
          throw new Error(
            `Status item EPC ${item.epc} berubah. Transaksi dibatalkan.`
          );
        }

        const updateTag = await client.query(
          `
          UPDATE tags
          SET status = 'AUTHORIZED_OUT',
              updated_at = NOW()
          WHERE id = $1
            AND status IN ('AUTHORIZED_OUT', 'RESERVED', 'IN_STOCK')
          RETURNING id
          `,
          [item.tag_id]
        );

        if (updateTag.rows.length === 0) {
          throw new Error(
            `Status tag EPC ${item.epc} berubah. Transaksi dibatalkan.`
          );
        }

        // Catat mutasi stok ke ledger.
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
            'OUT-' || REPLACE(gen_random_uuid()::TEXT, '-', ''),
            'OUTBOUND_SHIPMENT',
            $1,
            $2,
            $3,
            COALESCE($4, 'Gudang'),
            'Outbound / Pengiriman',
            -1,
            '-1 unit',
            $5,
            'System',
            $6,
            NULL
          )
          RETURNING *
          `,
          [
            item.product_id,
            item.sku,
            item.tag_id,
            item.location_name,
            invoice,
            item.location_id,
          ]
        );

        ledgerEntries.push(ledgerResult.rows[0]);
      }

      // 8. Kapasitas rak diperbarui otomatis oleh trigger PostgreSQL
      // trg_refresh_rack_capacity setelah UPDATE items.location_id.
      // Jangan mengubah locations.current_items_count secara manual di sini.

      // 9. Semua perubahan harus berhasil sebelum commit.
      await client.query('COMMIT');
      transactionStarted = false;

      // 9. Ambil saldo terbaru setelah commit.
      const stockData = await getAggregatedStockByProduct();

      // 10. Kirim event realtime setelah transaksi berhasil.
      try {
        publishRealtimeEvent('wms/stock/realtime', {
          event: 'OUTBOUND_SHIPMENT_COMPLETED',
          invoice_or_resi: invoice,
          total_items: itemResult.rows.length,
          gate_pass: gatePass,
          ledger_entries: ledgerEntries,
          current_stock: stockData,
        });
      } catch (mqttError) {
        app.log.error(mqttError, 'OUTBOUND MQTT ERROR');
      }

      return reply.code(201).send({
        success: true,
        message: 'Pengiriman dan mutasi stok berhasil dicatat.',
        data: {
          shipment: sale,
          gate_pass: gatePass,
          total_items: itemResult.rows.length,
          total_qty_change: -itemResult.rows.length,
          ledger: ledgerEntries,
        },
      });

    } catch (err) {
      if (transactionStarted && client) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          app.log.error(rollbackError, 'OUTBOUND ROLLBACK ERROR');
        }
      }

      const error = err as Error & {
        statusCode?: number;
        code?: string;
      };

      if (error.code === '23505') {
        return reply.code(409).send({
          success: false,
          message: 'Nomor resi sudah pernah digunakan.',
        });
      }

      if (error.statusCode) {
        return reply.code(error.statusCode).send({
          success: false,
          message: error.message,
        });
      }

      app.log.error(error, 'OUTBOUND SHIPMENT ERROR');

      return reply.code(500).send({
        success: false,
        message: 'Gagal memproses pengiriman.',
        error: error.message,
        code: error.code,
      });

    } finally {
      client?.release();
    }
  });
}
