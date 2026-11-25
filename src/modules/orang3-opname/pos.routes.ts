import { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { db, isPostgresConnected } from '../../config/db';
import { authenticate, requireRoles } from '../../middleware/auth';
import { publishRealtimeEvent } from '../../config/mqtt';

/**
 * MODUL ORANG 3: KASIR POS & MODUL RETUR
 */
export async function orang3PosRoutes(app: FastifyInstance) {

  // 1. GET Riwayat Penjualan POS
  app.get(
    '/api/pos/sales',
    {
      preHandler: [
        authenticate,
        requireRoles('KASIR', 'KASIR_POS', 'SUPERVISOR'),
      ],
    },
    async (request, reply) => {
      if (!isPostgresConnected) {
        return reply.code(503).send({
          success: false,
          message: 'Database PostgreSQL belum terhubung.',
        });
      }

      try {
        const result = await db.query(`
          SELECT
            s.id,
            s.invoice_or_resi AS invoice_no,
            s.order_type,
            s.customer_or_destination AS customer_name,
            s.total_items,
            s.total_amount,
            s.payment_status,
            s.shipping_status,
            s.created_at
          FROM sales s
          WHERE s.order_type = 'POS'
          ORDER BY s.created_at DESC
          LIMIT 50
        `);

        return reply.send({
          success: true,
          count: result.rows.length,
          data: result.rows,
        });
      } catch (error) {
        request.log.error(error, 'Gagal mengambil riwayat penjualan POS');

        return reply.code(500).send({
          success: false,
          message: 'Gagal mengambil riwayat penjualan POS.',
        });
      }
    }
  );

  // 2. GET Detail Barang dan EPC berdasarkan Invoice POS
app.get(
  '/api/pos/sales/:invoice_no/items',
  {
    preHandler: [
      authenticate,
      requireRoles('KASIR', 'KASIR_POS', 'SUPERVISOR'),
    ],
  },
  async (request, reply) => {
    if (!isPostgresConnected) {
      return reply.code(503).send({
        success: false,
        message: 'Database PostgreSQL belum terhubung.',
      });
    }

    try {
      const { invoice_no } = request.params as {
        invoice_no: string;
      };

      const saleResult = await db.query(
        `
        SELECT
        id,
        invoice_or_resi,
        customer_or_destination,
        total_items,
        total_amount,
        payment_status,
        payment_method,
        cashier_or_pic,
        created_at
        FROM public.sales
        WHERE invoice_or_resi = $1
        AND order_type = 'POS'
        LIMIT 1
        `,
        [invoice_no]
      );

      if (saleResult.rows.length === 0) {
        return reply.code(404).send({
          success: false,
          message: 'Invoice POS tidak ditemukan.',
        });
      }

      const itemsResult = await db.query(
        `
        SELECT
          sm.tag_id,
          sm.product_id,
          sm.sku,
          p.name AS product_name,
          p.unit_price,
          sm.qty_change,
          t.epc,
          t.status AS tag_status,
          EXISTS (
            SELECT 1
            FROM public.stock_movements rm
            WHERE rm.movement_type = 'RETURN_RESTOCK'
              AND rm.reference_doc = sm.reference_doc
              AND rm.tag_id = sm.tag_id
          ) AS already_returned
        FROM public.stock_movements sm
        INNER JOIN public.tags t ON t.id = sm.tag_id
        LEFT JOIN public.products p ON p.id = sm.product_id
        WHERE sm.movement_type = 'POS_SALE'
          AND sm.reference_doc = $1
        ORDER BY sm.created_at ASC
        `,
        [invoice_no]
      );

      return reply.send({
        success: true,
        data: {
          invoice: saleResult.rows[0],
          items: itemsResult.rows,
        },
      });
    } catch (error) {
      request.log.error(error, 'Gagal mengambil detail invoice POS');

      return reply.code(500).send({
        success: false,
        message: 'Gagal mengambil detail invoice POS.',
      });
    }
  }
);

  // 2. POST Scan RFID untuk POS
  app.post(
    '/api/pos/scan',
    {
      preHandler: [
        authenticate,
        requireRoles('KASIR', 'KASIR_POS', 'SUPERVISOR'),
      ],
    },
    async (request, reply) => {
      if (!isPostgresConnected) {
        return reply.code(503).send({
          success: false,
          message: 'Database PostgreSQL belum terhubung.',
        });
      }

      try {
        const { epc } = request.body as { epc?: string };

        if (!epc || !epc.trim()) {
          return reply.code(400).send({
            success: false,
            message: 'EPC RFID wajib diisi.',
          });
        }

        const result = await db.query(
          `
          SELECT
            t.id AS tag_id,
            t.epc,
            t.status AS tag_status,
            i.id AS item_id,
            i.status AS item_status,
            p.id AS product_id,
            p.sku,
            p.name AS product_name,
            p.category,
            p.unit_price,
            l.code AS rack_code,
            l.location_type
          FROM tags t
          INNER JOIN items i ON i.tag_id = t.id
          INNER JOIN products p ON p.id = i.product_id
          INNER JOIN locations l ON l.id = i.location_id
          WHERE t.epc = $1
          LIMIT 1
          `,
          [epc.trim()]
        );

        if (result.rows.length === 0) {
          // Cek apakah EPC / kode yang discan adalah Master Box atau Inner Box
          const boxResult = await db.query(
            `
            SELECT
              b.id AS box_id,
              b.box_code,
              b.master_epc,
              COALESCE(b.box_level, 'INNER') AS box_level,
              b.qty_per_box,
              b.status AS box_status,
              p.id AS product_id,
              p.sku,
              p.name AS product_name,
              p.category,
              p.unit_price,
              l.code AS rack_code
            FROM public.boxes b
            INNER JOIN public.products p ON p.id = b.product_id
            LEFT JOIN public.locations l ON l.id = b.location_id
            WHERE UPPER(b.master_epc) = UPPER($1) OR UPPER(b.box_code) = UPPER($1)
            LIMIT 1
            `,
            [epc.trim()]
          );

          if (boxResult.rows.length === 0) {
            return reply.code(404).send({
              success: false,
              message: 'RFID / Kode Box tidak ditemukan atau barang belum memiliki lokasi.',
            });
          }

          const box = boxResult.rows[0];
          const boxStatus = String(box.box_status || '').toUpperCase();
          if (!['IN_RACK', 'SEALED'].includes(boxStatus)) {
            return reply.code(409).send({
              success: false,
              message: `Box ${box.box_code} berstatus ${boxStatus} dan tidak tersedia untuk transaksi POS.`,
            });
          }

          return reply.send({
            success: true,
            message: `Box ${box.box_code} (${box.qty_per_box} unit) berhasil dibaca.`,
            data: {
              is_box: true,
              box_id: box.box_id,
              box_code: box.box_code,
              box_level: box.box_level,
              qty_per_box: Number(box.qty_per_box),
              epc: box.master_epc,
              product_id: box.product_id,
              sku: box.sku,
              name: box.product_name,
              category: box.category,
              price: Number(box.unit_price),
              rack_code: box.rack_code || 'INB01',
            },
          });
        }

        const item = result.rows[0];

        if (
          item.tag_status !== 'IN_STOCK' ||
          item.item_status !== 'IN_STOCK' ||
          item.location_type !== 'RACK'
        ) {
          return reply.code(409).send({
            success: false,
            message: 'Barang tidak tersedia untuk transaksi POS.',
          });
        }

        return reply.send({
          success: true,
          message: 'RFID berhasil dibaca.',
          data: {
            epc: item.epc,
            tag_id: item.tag_id,
            item_id: item.item_id,
            product_id: item.product_id,
            sku: item.sku,
            name: item.product_name,
            category: item.category,
            price: Number(item.unit_price),
            rack_code: item.rack_code,
          },
        });
      } catch (error) {
        request.log.error(error, 'Gagal memindai RFID POS');

        return reply.code(500).send({
          success: false,
          message: 'Terjadi kesalahan saat memindai RFID.',
        });
      }
    }
  );


  // 3. POST Checkout POS
  app.post(
    '/api/pos/checkout',
    {
      preHandler: [
        authenticate,
        requireRoles('KASIR', 'KASIR_POS', 'SUPERVISOR'),
      ],
    },
    async (request, reply) => {
      if (!isPostgresConnected) {
        return reply.code(503).send({
          success: false,
          message: 'Database PostgreSQL belum terhubung.',
        });
      }

      const body = (request.body ?? {}) as {
        customer_name?: string;
        payment?: string;
        items?: Array<{
          epc?: string;
          epcs?: string[];
          box_epcs?: string[];
        }>;
      };

      const customerName = body.customer_name?.trim();
      const payment = body.payment?.toUpperCase();

      if (!customerName) {
        return reply.code(400).send({
          success: false,
          message: 'Nama pelanggan wajib diisi.',
        });
      }

      if (!['CASH', 'QRIS'].includes(payment || '')) {
        return reply.code(400).send({
          success: false,
          message: 'Metode pembayaran harus CASH atau QRIS.',
        });
      }

      if (!Array.isArray(body.items) || body.items.length === 0) {
        return reply.code(400).send({
          success: false,
          message: 'Keranjang POS masih kosong.',
        });
      }

      // Ambil EPC satuan dan EPC Box dari setiap item keranjang.
      const epcs = body.items.flatMap((item) => [
        ...(Array.isArray(item.epcs) ? item.epcs : []),
        ...(item.epc ? [item.epc] : []),
      ]).map((epc) => epc.trim()).filter(Boolean);

      const boxEpcs = body.items.flatMap((item) =>
        Array.isArray(item.box_epcs) ? item.box_epcs : []
      ).map((epc) => epc.trim()).filter(Boolean);

      if (epcs.length === 0 && boxEpcs.length === 0) {
        return reply.code(400).send({
          success: false,
          message: 'Tidak ada EPC RFID atau Box dalam keranjang.',
        });
      }

      if (new Set(epcs).size !== epcs.length || new Set(boxEpcs).size !== boxEpcs.length) {
        return reply.code(400).send({
          success: false,
          message: 'Terdapat EPC duplikat dalam keranjang.',
        });
      }

      const user = request.user as {
        id?: string;
        full_name?: string;
      };

      const cashierId = user?.id;

      if (
        !cashierId ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          cashierId
        )
      ) {
        return reply.code(401).send({
          success: false,
          message: 'Identitas kasir tidak valid. Silakan login kembali.',
        });
      }

      const client = await db.connect();
      let committed = false;
      let invoiceNo = '';

      try {
        await client.query('BEGIN');

        // Pastikan akun kasir masih aktif.
        const cashierResult = await client.query(
          `SELECT id, full_name
           FROM public.users
           WHERE id = $1 AND is_active = TRUE`,
          [cashierId]
        );

        if (cashierResult.rows.length === 0) {
          await client.query('ROLLBACK');
          return reply.code(401).send({
            success: false,
            message: 'Akun kasir tidak ditemukan atau tidak aktif.',
          });
        }

        const cashierName = cashierResult.rows[0].full_name;

        // Kunci data RFID satuan dan Box selama proses checkout.
        let itemRows: any[] = [];
        if (epcs.length > 0) {
          const itemResult = await client.query(
            `
            SELECT
              t.id AS tag_id,
              t.epc,
              t.status AS tag_status,
              i.id AS item_id,
              i.status AS item_status,
              p.id AS product_id,
              p.sku,
              p.name AS product_name,
              p.unit_price,
              l.id AS location_id,
              l.code AS rack_code,
              l.location_type
            FROM public.tags t
            INNER JOIN public.items i ON i.tag_id = t.id
            INNER JOIN public.products p ON p.id = i.product_id
            INNER JOIN public.locations l ON l.id = i.location_id
            WHERE t.epc = ANY($1::text[])
            FOR UPDATE OF t, i
            `,
            [epcs]
          );

          if (itemResult.rows.length !== epcs.length) {
            await client.query('ROLLBACK');
            return reply.code(409).send({
              success: false,
              message: 'Ada RFID yang tidak ditemukan atau tidak memiliki data barang lengkap.',
            });
          }

          const invalidItem = itemResult.rows.find(
            (item) =>
              item.tag_status !== 'IN_STOCK' ||
              item.item_status !== 'IN_STOCK' ||
              item.location_type !== 'RACK'
          );

          if (invalidItem) {
            await client.query('ROLLBACK');
            return reply.code(409).send({
              success: false,
              message: `Barang dengan EPC ${invalidItem.epc} sudah tidak tersedia untuk dijual.`,
            });
          }
          itemRows = itemResult.rows;
        }

        let boxRows: any[] = [];
        if (boxEpcs.length > 0) {
          const boxQuery = await client.query(
            `
            SELECT
              b.id AS box_id,
              b.box_code,
              b.master_epc,
              b.qty_per_box,
              b.status AS box_status,
              b.location_id,
              p.id AS product_id,
              p.sku,
              p.name AS product_name,
              p.unit_price,
              l.code AS rack_code
            FROM public.boxes b
            INNER JOIN public.products p ON p.id = b.product_id
            LEFT JOIN public.locations l ON l.id = b.location_id
            WHERE b.master_epc = ANY($1::text[])
            FOR UPDATE OF b
            `,
            [boxEpcs]
          );

          if (boxQuery.rows.length !== boxEpcs.length) {
            await client.query('ROLLBACK');
            return reply.code(409).send({
              success: false,
              message: 'Ada Box EPC yang tidak ditemukan di database.',
            });
          }

          const invalidBox = boxQuery.rows.find(
            (b) => !['IN_RACK', 'SEALED'].includes(String(b.box_status || '').toUpperCase())
          );
          if (invalidBox) {
            await client.query('ROLLBACK');
            return reply.code(409).send({
              success: false,
              message: `Box ${invalidBox.box_code} berstatus ${invalidBox.box_status} dan tidak tersedia untuk dijual.`,
            });
          }
          boxRows = boxQuery.rows;
        }

        const totalQty =
          itemRows.length +
          boxRows.reduce((sum, b) => sum + Number(b.qty_per_box || 0), 0);

        const totalAmount =
          itemRows.reduce((total, item) => total + Number(item.unit_price), 0) +
          boxRows.reduce(
            (total, b) => total + Number(b.qty_per_box || 0) * Number(b.unit_price),
            0
          );

        invoiceNo = `POS-${Date.now()}-${randomUUID()
        .slice(0, 8)
        .toUpperCase()}`;

        // Simpan transaksi penjualan.
        const saleResult = await client.query(
          `
          INSERT INTO public.sales (
            id,
            invoice_or_resi,
            order_type,
            customer_or_destination,
            total_items,
            total_amount,
            payment_status,
            payment_method,
            cashier_or_pic
          )
          VALUES ($1, $2, 'POS', $3, $4, $5, 'PAID', $6, $7)
          RETURNING *
          `,
          [
            randomUUID(),
            invoiceNo,
            customerName,
            totalQty,
            totalAmount,
            payment,
            cashierId,
          ]
        );

        const sale = saleResult.rows[0];

        // Catat pengurangan stok melalui ledger (item satuan).
        for (const item of itemRows) {
          await client.query(
            `
            INSERT INTO public.stock_movements (
              id,
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
              performed_by,
              from_location_id,
              to_location_id
            )
            VALUES (
              $1, $2, 'POS_SALE', $3, $4, $5,
              $6, 'POS', -1, 'UNIT', $7, $8, $9, $10, NULL
            )
            `,
            [
              randomUUID(),
              `POS-${randomUUID()}`,
              item.product_id,
              item.sku,
              item.tag_id,
              item.rack_code,
              invoiceNo,
              cashierName,
              cashierId,
              item.location_id,
            ]
          );
        }

        // Catat pengurangan stok melalui ledger (Box).
        for (const b of boxRows) {
          const boxQty = Number(b.qty_per_box || 0);
          await client.query(
            `
            INSERT INTO public.stock_movements (
              id,
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
              performed_by,
              from_location_id,
              to_location_id
            )
            VALUES (
              $1, $2, 'POS_SALE', $3, $4, NULL,
              $5, 'POS', $6, $7, $8, $9, $10, $11, NULL
            )
            `,
            [
              randomUUID(),
              `POS-BOX-${randomUUID()}`,
              b.product_id,
              b.sku,
              b.rack_code || 'INB01',
              -boxQty,
              `${boxQty} UNIT (${b.box_code})`,
              invoiceNo,
              cashierName,
              cashierId,
              b.location_id || null,
            ]
          );
        }

        if (epcs.length > 0) {
          await client.query(
            `
            UPDATE public.tags
            SET status = 'RESERVED', updated_at = NOW()
            WHERE epc = ANY($1::text[])
            `,
            [epcs]
          );
        }

        if (boxEpcs.length > 0) {
          await client.query(
            `
            UPDATE public.boxes
            SET status = 'SHIPPED'
            WHERE master_epc = ANY($1::text[])
            `,
            [boxEpcs]
          );
        }

        await client.query('COMMIT');
        committed = true;

        // Minta Orang 4 menerbitkan Gate Pass.
        const allGateEpcs = [...epcs, ...boxEpcs];
        request.log.info('MULAI MEMANGGIL ENDPOINT GATE PASS');

        const gatePassResponse = await app.inject({
          method: 'POST',
          url: '/api/gate-passes/generate',
          payload: {
            sale_id: sale.id,
            reference_resi: invoiceNo,
            reference_type: 'POS',
            customer_or_destination: customerName,
            courier: null,
            epc_list: allGateEpcs,
            authorized_by: cashierId,
            valid_hours: 4,
          },
        });

        request.log.info({
          statusCode: gatePassResponse.statusCode,
          body: gatePassResponse.body,
        }, 'HASIL PEMANGGILAN GATE PASS');


        let gatePassResult: any;

        try {
          gatePassResult = gatePassResponse.json();
        } catch {
          gatePassResult = null;
        }

        if (
          gatePassResponse.statusCode < 200 ||
          gatePassResponse.statusCode >= 300 ||
          !gatePassResult?.success
        ) {
          request.log.error(
            {
              invoiceNo,
              gatePassStatus: gatePassResponse.statusCode,
              gatePassBody: gatePassResponse.body,
            },
            'Penjualan berhasil, tetapi Gate Pass gagal diterbitkan.'
          );

          return reply.code(502).send({
            success: false,
            sale_created: true,
            gate_pass_issued: false,
            message:
              'Penjualan berhasil dicatat, tetapi Gate Pass gagal diterbitkan. Jangan ulangi checkout. Hubungi petugas untuk menerbitkan Gate Pass.',
            data: {
              invoice_no: invoiceNo,
              sale_id: sale.id,
              total_items: totalQty,
              total_amount: totalAmount,
              payment_method: payment,
            },
          });
        }

        return reply.code(201).send({
          success: true,
          message: 'Checkout berhasil dan Gate Pass berhasil diterbitkan.',
          data: {
            invoice_no: invoiceNo,
            sale_id: sale.id,
            customer_name: customerName,
            total_items: totalQty,
            total_amount: totalAmount,
            payment_method: payment,
            payment_status: 'PAID',
            items: [
              ...itemRows.map((item) => ({
                epc: item.epc,
                sku: item.sku,
                product_name: item.product_name,
                price: Number(item.unit_price),
                rack_code: item.rack_code,
              })),
              ...boxRows.map((b) => ({
                epc: b.master_epc,
                box_code: b.box_code,
                qty_per_box: Number(b.qty_per_box),
                sku: b.sku,
                product_name: b.product_name,
                price: Number(b.unit_price),
                rack_code: b.rack_code || 'INB01',
              })),
            ],
            gate_pass: gatePassResult.data,
          },
        });
      } catch (error) {
        if (!committed) {
          await client.query('ROLLBACK').catch(() => undefined);
        }

        request.log.error(error, 'Gagal melakukan checkout POS');

        return reply.code(500).send({
        success: false,
        sale_created: committed,
        message: committed
          ? 'Penjualan sudah tercatat, tetapi terjadi kesalahan setelah transaksi disimpan. Periksa status Gate Pass sebelum melakukan tindakan lanjutan.'
          : 'Checkout gagal. Transaksi database telah dibatalkan.',
        data: committed
          ? {
              invoice_no: invoiceNo,
            }
          : null,
      });
      } finally {
        client.release();
      }
    }

  );

  // 4. POST Retur Barang POS
  app.post(
    '/api/pos/return',
    {
      preHandler: [
        authenticate,
        requireRoles('KASIR', 'KASIR_POS', 'SUPERVISOR'),
      ],
    },
    async (request, reply) => {
      if (!isPostgresConnected) {
        return reply.code(503).send({
          success: false,
          message: 'Database PostgreSQL belum terhubung.',
        });
      }

      const body = request.body as {
        invoice_no?: string;
        epc?: string;
        reason?: string;
        target_rack?: string;
      };

      const invoiceNo = body.invoice_no?.trim();
      const epc = body.epc?.trim();
      const reason = body.reason?.trim();
      const targetRack = body.target_rack?.trim();

      if (!invoiceNo || !epc || !reason || !targetRack) {
        return reply.code(400).send({
          success: false,
          message:
            'Nomor invoice, EPC, alasan retur, dan rak tujuan wajib diisi.',
        });
      }

      
      try {


        // Pastikan EPC tercatat dalam transaksi tersebut.
        const itemResult = await db.query(
          `
          SELECT
            sm.tag_id,
            sm.product_id,
            sm.sku,
            t.epc
          FROM public.stock_movements sm
          INNER JOIN public.tags t ON t.id = sm.tag_id
          WHERE sm.movement_type = 'POS_SALE'
            AND sm.reference_doc = $1
            AND t.epc = $2
          LIMIT 1
          `,
          [invoiceNo, epc]
        );

        if (itemResult.rows.length === 0) {
          return reply.code(404).send({
            success: false,
            message: 'EPC tidak ditemukan dalam transaksi POS tersebut.',
          });
        }

        const returnedItem = itemResult.rows[0];

        // Ambil seluruh EPC yang tercatat dalam invoice POS.
        const invoiceItemsResult = await db.query(
          `
            SELECT
              sm.tag_id,
              t.epc,
              t.status AS tag_status,
              EXISTS (
                SELECT 1
                FROM public.stock_movements rm
                WHERE rm.movement_type = 'RETURN_RESTOCK'
                  AND rm.reference_doc = sm.reference_doc
                  AND rm.tag_id = sm.tag_id
              ) AS already_returned
            FROM public.stock_movements sm
            INNER JOIN public.tags t ON t.id = sm.tag_id
            WHERE sm.movement_type = 'POS_SALE'
              AND sm.reference_doc = $1
          `,
          [invoiceNo]
        );


        // Cegah EPC diretur lebih dari satu kali.
        const duplicateResult = await db.query(
          `
          SELECT id
          FROM public.stock_movements
          WHERE movement_type = 'RETURN_RESTOCK'
            AND reference_doc = $1
            AND tag_id = $2
          LIMIT 1
          `,
          [invoiceNo, returnedItem.tag_id]
        );

        if (duplicateResult.rows.length > 0) {
          return reply.code(409).send({
            success: false,
            message: 'Barang dengan EPC tersebut sudah pernah diretur.',
          });
        }


        // Validasi rak tujuan retur.
        const rackResult = await db.query(
          `
          SELECT id, code, location_type
          FROM public.locations
          WHERE code = $1
            AND location_type = 'RACK'
          LIMIT 1
          `,
          [targetRack]
        );

        if (rackResult.rows.length === 0) {
          return reply.code(404).send({
            success: false,
            message: 'Rak tujuan tidak ditemukan atau bukan lokasi rak.',
          });
        }

        const targetLocation = rackResult.rows[0];

        const user = request.user as {
        id?: string;
        full_name?: string;
          };

        if (!user?.id) {
          return reply.code(401).send({
            success: false,
            message: 'Identitas petugas tidak ditemukan.',
          });
        }
        
        
        // Proses restock dalam satu transaksi database.
        const client = await db.connect();
        let committed = false;
        let gatePassCancelled = false;
        let latestInvoiceItems: any = null;
        let lockedSaleData: any = null;

        try {
          await client.query('BEGIN');

          // Kunci transaksi penjualan agar retur invoice yang sama
          // tidak diproses bersamaan.
          // Kunci transaksi penjualan dan ambil data invoice.
            const lockedSale = await client.query(
              `
              SELECT
                id,
                invoice_or_resi,
                customer_or_destination
              FROM public.sales
              WHERE invoice_or_resi = $1
                AND order_type = 'POS'
              FOR UPDATE
              `,
              [invoiceNo]
            );

            if (lockedSale.rows.length === 0) {
              await client.query('ROLLBACK');

              return reply.code(404).send({
                success: false,
                message: 'Transaksi POS tidak ditemukan.',
              });
            }

            lockedSaleData = lockedSale.rows[0];

          // Ambil Gate Pass terbaru untuk invoice ini.
          const gatePassResult = await client.query(
            `
            SELECT pass_code, status
            FROM public.gate_passes
            WHERE reference_resi = $1
            ORDER BY created_at DESC
            LIMIT 1
            `,
            [invoiceNo]
          );

          if (gatePassResult.rows.length === 0) {
            await client.query('ROLLBACK');

            return reply.code(404).send({
              success: false,
              message: 'Gate Pass untuk transaksi ini tidak ditemukan.',
            });
          }

          const gatePass = gatePassResult.rows[0];

          // Validasi status Gate Pass.
          const allowedGatePassStatuses = [
            'ACTIVE',
            'USED',
            'REVOKED',
            'EXPIRED',
          ];

          if (!allowedGatePassStatuses.includes(gatePass.status)) {
            await client.query('ROLLBACK');

            return reply.code(409).send({
              success: false,
              message: `Status Gate Pass ${gatePass.status} tidak dapat diproses untuk retur.`,
            });
          }
          
          // Ambil ulang status EPC setelah invoice dikunci.
          latestInvoiceItems = await client.query(
            `
            SELECT
              sm.tag_id,
              t.epc,
              t.status AS tag_status,
              EXISTS (
                SELECT 1
                FROM public.stock_movements rm
                WHERE rm.movement_type = 'RETURN_RESTOCK'
                  AND rm.reference_doc = sm.reference_doc
                  AND rm.tag_id = sm.tag_id
              ) AS already_returned
            FROM public.stock_movements sm
            INNER JOIN public.tags t ON t.id = sm.tag_id
            WHERE sm.movement_type = 'POS_SALE'
              AND sm.reference_doc = $1
              FOR UPDATE OF t
            `,
            [invoiceNo]
          );

          const remainingEpcs = latestInvoiceItems.rows
            .filter(
              (item: any) =>
                !item.already_returned &&
                item.tag_id !== returnedItem.tag_id &&
                item.tag_status === 'AUTHORIZED_OUT'
            )
            .map((item: any) => item.epc);

          const needsReplacementGatePass = remainingEpcs.length > 0;

          // Periksa ulang retur ganda di dalam transaksi.
          const duplicateCheck = await client.query(
            `
            SELECT id
            FROM public.stock_movements
            WHERE movement_type = 'RETURN_RESTOCK'
              AND reference_doc = $1
              AND tag_id = $2
            LIMIT 1
            `,
            [invoiceNo, returnedItem.tag_id]
          );

          if (duplicateCheck.rows.length > 0) {
            await client.query('ROLLBACK');
            return reply.code(409).send({
              success: false,
              message: 'Barang ini sudah pernah diretur.',
            });
          }

          // Kunci data RFID dan barang.
          const currentItem = await client.query(
            `
            SELECT
              t.id AS tag_id,
              t.epc,
              t.status AS tag_status,
              i.id AS item_id,
              i.status AS item_status,
              i.location_id
            FROM public.tags t
            INNER JOIN public.items i ON i.tag_id = t.id
            WHERE t.id = $1
            FOR UPDATE OF t, i
            `,
            [returnedItem.tag_id]
          );

          if (currentItem.rows.length === 0) {
            await client.query('ROLLBACK');
            return reply.code(404).send({
              success: false,
              message: 'Data barang atau RFID tidak ditemukan.',
            });
          }

          const item = currentItem.rows[0];

          if (!['AUTHORIZED_OUT', 'EXITED'].includes(item.tag_status)) {
            await client.query('ROLLBACK');
            return reply.code(409).send({
              success: false,
              message: `Status RFID ${item.tag_status} tidak sesuai untuk proses retur.`,
            });
          }

        // Gate Pass aktif harus dibatalkan sebelum restock.
        if (gatePass.status === 'ACTIVE') {
          const cancelResponse = await app.inject({
            method: 'POST',
            url: `/api/gate-passes/${encodeURIComponent(gatePass.pass_code)}/cancel`,
            payload: {
              reason: 'Retur barang dari transaksi POS',
              cancelled_by: 'Petugas POS',
            },
          });

          let cancelResult: any;

          try {
            cancelResult = cancelResponse.json();
          } catch {
            cancelResult = null;
          }

          if (
            cancelResponse.statusCode < 200 ||
            cancelResponse.statusCode >= 300 ||
            !cancelResult?.success
          ) {
            request.log.error({
              statusCode: cancelResponse.statusCode,
              body: cancelResponse.body,
            }, 'Gagal membatalkan Gate Pass untuk retur POS');

            await client.query('ROLLBACK');

            return reply.code(502).send({
              success: false,
              message: 'Gate Pass gagal dibatalkan. Proses retur dihentikan.',
            });
          }
          gatePassCancelled = true;
        }

          // Catat penambahan stok melalui ledger.
          await client.query(
            `
            INSERT INTO public.stock_movements (
              id,
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
              performed_by,
              from_location_id,
              to_location_id
            )
            VALUES (
              $1, $2, 'RETURN_RESTOCK', $3, $4, $5,
              'POS_RETURN', $6, 1, 'UNIT', $7, $8, $9, NULL, $10
            )
            `,
            [
              randomUUID(),
              `RETURN-${randomUUID()}`,
              returnedItem.product_id,
              returnedItem.sku,
              returnedItem.tag_id,
              targetLocation.code,
              invoiceNo,
              user.full_name || 'Petugas POS',
              user.id,
              targetLocation.id,
            ]
          );

          // Kembalikan status RFID menjadi IN_STOCK.
          await client.query(
            `
            UPDATE public.tags
            SET status = 'IN_STOCK',
                updated_at = NOW()
            WHERE id = $1
            `,
            [returnedItem.tag_id]
          );

          // Kembalikan barang ke rak tujuan.
          await client.query(
            `
            UPDATE public.items
            SET status = 'IN_STOCK',
                location_id = $1,
                updated_at = NOW()
            WHERE id = $2
            `,
            [targetLocation.id, item.item_id]
          );


          // Perbarui status invoice berdasarkan seluruh barang yang sudah diretur.
          await client.query(
            `
            UPDATE public.sales s
            SET shipping_status = CASE
              WHEN NOT EXISTS (
                SELECT 1
                FROM public.stock_movements sm
                WHERE sm.movement_type = 'POS_SALE'
                  AND sm.reference_doc = s.invoice_or_resi
                  AND NOT EXISTS (
                    SELECT 1
                    FROM public.stock_movements rm
                    WHERE rm.movement_type = 'RETURN_RESTOCK'
                      AND rm.reference_doc = sm.reference_doc
                      AND rm.tag_id = sm.tag_id
                  )
              )
              THEN 'RETURNED'
              ELSE 'GATE_PASS_ISSUED'
            END
            WHERE s.invoice_or_resi = $1
              AND s.order_type = 'POS'
            `,
            [invoiceNo]
          );


          await client.query('COMMIT');
          committed = true;

          // Terbitkan Gate Pass pengganti untuk EPC yang masih tersisa.
          let replacementGatePass: any = null;
          let replacementGatePassIssued = true;

          if (needsReplacementGatePass) {
            try {
              const replacementResponse = await app.inject({
                method: 'POST',
                url: '/api/gate-passes/generate',
                payload: {
                  sale_id: lockedSaleData.id,
                  reference_resi: invoiceNo,
                  reference_type: 'POS',
                  customer_or_destination:
                    lockedSaleData.customer_or_destination,
                  courier: null,
                  epc_list: remainingEpcs,
                  authorized_by: user.id,
                  valid_hours: 4,
                },
              });

              try {
                replacementGatePass = replacementResponse.json();
              } catch {
                replacementGatePass = null;
              }

              if (
                replacementResponse.statusCode < 200 ||
                replacementResponse.statusCode >= 300 ||
                !replacementGatePass?.success
              ) {
                replacementGatePassIssued = false;

                request.log.error({
                  statusCode: replacementResponse.statusCode,
                  body: replacementResponse.body,
                }, 'Gagal menerbitkan Gate Pass pengganti untuk retur POS');
              }
            } catch (error) {
              replacementGatePassIssued = false;

              request.log.error(
                error,
                'Terjadi kesalahan saat menerbitkan Gate Pass pengganti'
              );
            }
          }

          return reply.send({
            success: true,
            message:
            needsReplacementGatePass && !replacementGatePassIssued
              ? 'Retur berhasil dan stok telah dikembalikan, tetapi Gate Pass pengganti gagal diterbitkan. Hubungi petugas untuk menerbitkan Gate Pass.'
              : 'Retur berhasil dan stok telah dikembalikan.',
            data: {
              invoice_no: invoiceNo,
              epc: returnedItem.epc,
              sku: returnedItem.sku,
              movement_type: 'RETURN_RESTOCK',
              qty_change: 1,
              tag_status: 'IN_STOCK',
              item_status: 'IN_STOCK',
              target_rack: targetLocation.code,
              reason,
              gate_pass_replacement_required: needsReplacementGatePass,
              gate_pass_replacement_issued: needsReplacementGatePass
                ? replacementGatePassIssued
                : null,
              gate_pass_replacement: replacementGatePass?.data || null,
            },
          });
        } catch (error) {
  if (!committed) {
    await client.query('ROLLBACK').catch(() => undefined);
  }

  // Pulihkan Gate Pass jika pembatalan berhasil,
  // tetapi transaksi retur gagal.
  if (!committed && gatePassCancelled) {
    try {
      const recoveryEpcs = latestInvoiceItems.rows
        .filter(
          (item: any) =>
            !item.already_returned &&
            item.tag_status === 'AUTHORIZED_OUT'
        )
        .map((item: any) => item.epc);

      if (recoveryEpcs.length > 0) {
        const recoveryResponse = await app.inject({
          method: 'POST',
          url: '/api/gate-passes/generate',
          payload: {
            sale_id: lockedSaleData.id,
            reference_resi: invoiceNo,
            reference_type: 'POS',
            customer_or_destination:
              lockedSaleData.customer_or_destination,
            courier: null,
            epc_list: recoveryEpcs,
            authorized_by: user.id,
            valid_hours: 4,
          },
        });

        const recoveryResult = recoveryResponse.json();

        if (
          recoveryResponse.statusCode < 200 ||
          recoveryResponse.statusCode >= 300 ||
          !recoveryResult?.success
        ) {
          request.log.error({
            statusCode: recoveryResponse.statusCode,
            body: recoveryResponse.body,
          }, 'Pemulihan Gate Pass setelah kegagalan retur tidak berhasil');
        }
      }
    } catch (recoveryError) {
      request.log.error(
        recoveryError,
        'Terjadi kesalahan saat memulihkan Gate Pass setelah kegagalan retur'
      );
    }
  }

  throw error;
} finally {
  client.release();
}

      } catch (error) {
        request.log.error(error, 'Gagal memvalidasi retur POS');

        return reply.code(500).send({
          success: false,
          message: 'Terjadi kesalahan saat memvalidasi retur.',
        });
      }

        }
  );

  // 5. POST Simulasi Desktop RFID Reader untuk POS
  app.post(
    '/api/pos/rfid-reader/simulate',
    {
      preHandler: [
        authenticate,
        requireRoles('KASIR', 'KASIR_POS', 'SUPERVISOR'),
      ],
    },
    async (request, reply) => {
      const body = request.body as { epc?: string };
      const epc = body.epc?.trim();

      if (!epc) {
        return reply.code(400).send({
          success: false,
          message: 'EPC RFID wajib diisi.',
        });
      }

      publishRealtimeEvent('wms/pos/live-scan', {
        event: 'POS_RFID_SCANNED',
        epc,
        device: 'DESKTOP-RFID-SIM-01',
      });

      return reply.send({
        success: true,
        message: 'EPC berhasil dikirim ke MQTT live-scan.',
        data: { epc },
      });
    }
  );

}

