import { FastifyInstance } from 'fastify';
import { db, isPostgresConnected, memoryStore } from '../../config/db';
import { publishRealtimeEvent } from '../../config/mqtt';

/**
 * ============================================================================
 * MODUL ORANG 1: PENERIMAAN BARANG (INBOUND GRN), MASTER SKU & TAGGING RFID
 * ============================================================================
 */
export async function orang1InboundRoutes(app: FastifyInstance) {
  // 1. GET Daftar Master Produk / SKU
  app.get('/api/products', async () => {
    if (isPostgresConnected) {
      const res = await db.query('SELECT * FROM products ORDER BY id ASC');
      return { success: true, data: res.rows };
    }
    return { success: true, data: memoryStore.products };
  });

  // 2. POST Tambah Master Produk / SKU Baru
  app.post('/api/products', async (request, reply) => {
    const { sku, name, category, min_stock_alert = 20, price = 0 } = request.body as {
      sku: string;
      name: string;
      category: string;
      min_stock_alert?: number;
      price?: number;
    };

    if (isPostgresConnected) {
      const res = await db.query(
        `INSERT INTO products (sku, name, category, min_stock_alert, price)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [sku, name, category, min_stock_alert, price]
      );
      return reply.code(201).send({ success: true, data: res.rows[0] });
    }

    const newProd = {
      id: memoryStore.products.length + 1,
      sku,
      name,
      category,
      min_stock_alert,
      price,
    };
    memoryStore.products.push(newProd);
    return reply.code(201).send({ success: true, data: newProd });
  });

  // 3. GET Daftar Dokumen Penerimaan (Inbound GRN)
  app.get('/api/inbound/grn', async () => {
    if (isPostgresConnected) {
      const res = await db.query('SELECT * FROM goods_receipts ORDER BY id DESC');
      return { success: true, data: res.rows };
    }
    return { success: true, data: memoryStore.goods_receipts };
  });

  // 4. POST Catat Penerimaan Barang Baru (GRN)
  app.post('/api/inbound/grn', async (request, reply) => {
    const { po_number, supplier_name, receipt_date, total_qty, rfid_tagging_status } =
      request.body as {
        po_number: string;
        supplier_name: string;
        receipt_date?: string;
        total_qty: number;
        rfid_tagging_status?: string;
      };

    if (isPostgresConnected) {
      const res = await db.query(
        `INSERT INTO goods_receipts (po_number, supplier_name, receipt_date, total_qty, rfid_tagging_status, status)
         VALUES ($1, $2, COALESCE($3::DATE, CURRENT_DATE), $4, $5, 'SELESAI') RETURNING *`,
        [po_number, supplier_name, receipt_date || null, total_qty, rfid_tagging_status || 'Auto-Encoded']
      );
      return reply.code(201).send({ success: true, data: res.rows[0] });
    }

    const newGrn = {
      id: memoryStore.goods_receipts.length + 1,
      po_number,
      supplier_name,
      receipt_date: receipt_date || new Date().toISOString().slice(0, 10),
      total_qty: Number(total_qty),
      rfid_tagging_status: rfid_tagging_status || 'Auto-Encoded',
      status: 'SELESAI',
    };
    memoryStore.goods_receipts.unshift(newGrn);
    return reply.code(201).send({ success: true, data: newGrn });
  });

  // 5. GET Daftar Tag RFID Terdaftar
  app.get('/api/tags', async () => {
    if (isPostgresConnected) {
      const res = await db.query(`
        SELECT t.*, p.sku, p.name AS product_name, l.rack_name
        FROM tags t
        LEFT JOIN items i ON t.id = i.tag_id
        LEFT JOIN products p ON i.product_id = p.id
        LEFT JOIN locations l ON i.location_id = l.id
        ORDER BY t.id DESC
      `);
      return { success: true, data: res.rows };
    }
    return { success: true, data: memoryStore.tags };
  });

  // 6. POST Encode Tag RFID Baru & Tautkan ke SKU (Meja Penerimaan)
  app.post('/api/tags/encode', async (request, reply) => {
    const { product_id, type = 'STANDARD_LABEL', epc_custom } = request.body as {
      product_id: number;
      type?: 'STANDARD_LABEL' | 'ON_METAL' | 'HARD_TAG';
      epc_custom?: string;
    };

    const randHex = Math.floor(1000 + Math.random() * 9000).toString(16).toUpperCase();
    const epc = epc_custom || `E280-1160-2000-${randHex}`;

    if (isPostgresConnected) {
      const tagRes = await db.query(
        `INSERT INTO tags (epc, type, status) VALUES ($1, $2, 'ENCODED') RETURNING *`,
        [epc, type]
      );
      const itemRes = await db.query(
        `INSERT INTO items (product_id, tag_id) VALUES ($1, $2) RETURNING *`,
        [product_id, tagRes.rows[0].id]
      );
      publishRealtimeEvent('wms/tags/encoded', { epc, product_id, status: 'ENCODED' });
      return reply.code(201).send({ success: true, tag: tagRes.rows[0], item: itemRes.rows[0] });
    }

    const prod = memoryStore.products.find((p) => p.id === Number(product_id));
    const newTag = {
      id: memoryStore.tags.length + 1,
      epc,
      type,
      status: 'ENCODED',
      last_rssi: '-52 dBm',
      sku: prod?.sku || 'SKU-NEW',
      product_name: prod?.name || 'Barang Baru',
      rack_name: 'Meja Tagging Inbound',
    };
    memoryStore.tags.unshift(newTag);
    publishRealtimeEvent('wms/tags/encoded', { epc, product_id, status: 'ENCODED' });

    return reply.code(201).send({ success: true, tag: newTag, item: { product_id, tag_id: newTag.id } });
  });
}
