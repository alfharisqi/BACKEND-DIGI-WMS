
import { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { db, isPostgresConnected } from '../../config/db';
import { authenticate, requireRoles } from '../../middleware/auth';

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
          return reply.code(404).send({
            success: false,
            message: 'RFID tidak ditemukan atau barang belum memiliki lokasi.',
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

      const body = request.body as {
        customer_name?: string;
        payment?: string;
        items?: Array<{
          epc?: string;
          epcs?: string[];
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

      // Ambil EPC dari setiap item keranjang.
      const epcs = body.items.flatMap((item) => [
        ...(Array.isArray(item.epcs) ? item.epcs : []),
        ...(item.epc ? [item.epc] : []),
      ]).map((epc) => epc.trim()).filter(Boolean);

      if (epcs.length === 0) {
        return reply.code(400).send({
          success: false,
          message: 'Tidak ada EPC RFID dalam keranjang.',
        });
      }

      if (new Set(epcs).size !== epcs.length) {
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

        // Kunci data RFID dan barang selama proses checkout.
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

        const totalAmount = itemResult.rows.reduce(
          (total, item) => total + Number(item.unit_price),
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
            itemResult.rows.length,
            totalAmount,
            payment,
            cashierId,
          ]
        );

        const sale = saleResult.rows[0];

        // Catat pengurangan stok melalui ledger.
        for (const item of itemResult.rows) {
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

        // Tandai RFID sebagai RESERVED agar tidak dijual ulang
        // jika penerbitan Gate Pass mengalami kegagalan.
        await client.query(
          `
          UPDATE public.tags
          SET status = 'RESERVED', updated_at = NOW()
          WHERE epc = ANY($1::text[])
          `,
          [epcs]
        );

        await client.query('COMMIT');
        committed = true;

        // Minta Orang 4 menerbitkan Gate Pass.
        
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
            epc_list: epcs,
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
              total_items: itemResult.rows.length,
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
            total_items: itemResult.rows.length,
            total_amount: totalAmount,
            payment_method: payment,
            payment_status: 'PAID',
            items: itemResult.rows.map((item) => ({
              epc: item.epc,
              sku: item.sku,
              product_name: item.product_name,
              price: Number(item.unit_price),
              rack_code: item.rack_code,
            })),
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


}
