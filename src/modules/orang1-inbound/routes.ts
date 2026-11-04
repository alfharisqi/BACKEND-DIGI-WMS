import { FastifyInstance } from 'fastify';
import { db, isPostgresConnected, memoryStore, getCalculatedLedgerStock } from '../../config/db';
import { publishRealtimeEvent } from '../../config/mqtt';

/**
 * ============================================================================
 * MODUL ORANG 1: PENERIMAAN BARANG (INBOUND GRN), MASTER SKU & TAGGING RFID
 * ============================================================================
 */
export async function orang1InboundRoutes(app: FastifyInstance) {
  // 1. GET Daftar Master Produk / SKU (dilengkapi current_stock dari Ledger)
  app.get('/api/products', async () => {
    if (isPostgresConnected) {
      const res = await db.query('SELECT * FROM products ORDER BY id ASC');
      return { status: 'ok', success: true, data: res.rows };
    }
    const ledgerMap = new Map(
      getCalculatedLedgerStock().map((s) => [s.product_id, s.current_stock])
    );
    const enriched = memoryStore.products.map((p, idx) => ({
      ...p,
      price_idr: p.price,
      min_stock: p.min_stock_alert,
      current_stock: ledgerMap.get(p.id) ?? 20,
      default_rack: idx % 2 === 0 ? 'Rak A1-01' : 'Rak B2-01',
    }));
    return { status: 'ok', success: true, data: enriched };
  });

  // 2. POST Tambah Master Produk / SKU Baru
  app.post('/api/products', async (request, reply) => {
    const body = request.body as {
      sku: string;
      name: string;
      category: string;
      min_stock_alert?: number;
      min_stock?: number;
      price?: number;
      price_idr?: number;
    };
    const sku = body.sku;
    const name = body.name;
    const category = body.category || 'Aksesoris Komputer';
    const min_stock_alert = Number(body.min_stock_alert ?? body.min_stock ?? 20);
    const price = Number(body.price ?? body.price_idr ?? 0);

    if (isPostgresConnected) {
      const res = await db.query(
        `INSERT INTO products (sku, name, category, min_stock_alert, price)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [sku, name, category, min_stock_alert, price]
      );
      return reply.code(201).send({
        status: 'ok',
        success: true,
        message: `Barang ${name} (${sku}) berhasil ditambahkan`,
        data: res.rows[0],
      });
    }

    const newProd = {
      id: memoryStore.products.length + 1,
      sku,
      name,
      category,
      min_stock_alert,
      price,
      price_idr: price,
      min_stock: min_stock_alert,
      current_stock: 0,
    };
    memoryStore.products.push(newProd);
    return reply.code(201).send({
      status: 'ok',
      success: true,
      message: `Barang ${name} (${sku}) berhasil ditambahkan`,
      data: newProd,
    });
  });

  // 3. GET Daftar Dokumen Penerimaan (Inbound GRN)
  app.get('/api/inbound/grn', async () => {
    if (isPostgresConnected) {
      const res = await db.query('SELECT * FROM goods_receipts ORDER BY id DESC');
      return { status: 'ok', success: true, data: res.rows };
    }
    return { status: 'ok', success: true, data: memoryStore.goods_receipts };
  });

  // 4. POST Catat Penerimaan Barang Baru (GRN)
  app.post('/api/inbound/grn', async (request, reply) => {
    const body = request.body as {
      po_number?: string;
      supplier_name?: string;
      receipt_date?: string;
      total_qty?: number;
      qty?: number;
      sku?: string;
      rfid_tagging_status?: string;
    };
    const po_number = body.po_number || `PO-2026-${Math.floor(1000 + Math.random() * 9000)}`;
    const supplier_name = body.supplier_name || 'Supplier Mitra DIGI WMS';
    const total_qty = Number(body.total_qty ?? body.qty ?? 10);
    const receipt_date = body.receipt_date;
    const rfid_tagging_status = body.rfid_tagging_status || 'Auto-Encoded';

    if (isPostgresConnected) {
      const res = await db.query(
        `INSERT INTO goods_receipts (po_number, supplier_name, receipt_date, total_qty, rfid_tagging_status, status)
         VALUES ($1, $2, COALESCE($3::DATE, CURRENT_DATE), $4, $5, 'SELESAI') RETURNING *`,
        [po_number, supplier_name, receipt_date || null, total_qty, rfid_tagging_status]
      );
      return reply.code(201).send({
        status: 'ok',
        success: true,
        message: `Penerimaan ${po_number} (${total_qty} unit) berhasil dicatat!`,
        data: res.rows[0],
      });
    }

    const newGrn = {
      id: memoryStore.goods_receipts.length + 1,
      po_number,
      supplier_name,
      receipt_date: receipt_date || new Date().toISOString().slice(0, 10),
      total_qty,
      rfid_tagging_status,
      status: 'SELESAI',
    };
    memoryStore.goods_receipts.unshift(newGrn);

    if (body.sku) {
      const prod = memoryStore.products.find((p) => p.sku === body.sku) || memoryStore.products[0];
      if (prod) {
        memoryStore.stock_movements.unshift({
          id: memoryStore.stock_movements.length + 1,
          tx_code: `TX-${1000 + memoryStore.stock_movements.length + 1}`,
          movement_type: 'INBOUND_GRN',
          product_id: prod.id,
          sku: prod.sku,
          product_name: prod.name,
          from_location: supplier_name,
          to_location: 'Zona Transit Inbound D2',
          qty: total_qty,
          reference_doc: po_number,
          operator_name: 'Sarah Jenkins',
          created_at: new Date().toISOString(),
        });
      }
    }

    return reply.code(201).send({
      status: 'ok',
      success: true,
      message: `Penerimaan ${po_number} (${total_qty} unit) berhasil dicatat ke Ledger!`,
      data: newGrn,
    });
  });

  // 5. GET Daftar Tag RFID Terdaftar (Mendukung /api/tags dan /api/rfid/tags)
  const getTagsHandler = async () => {
    if (isPostgresConnected) {
      const res = await db.query(`
        SELECT t.*, p.sku, p.name AS product_name, l.rack_name
        FROM tags t
        LEFT JOIN items i ON t.id = i.tag_id
        LEFT JOIN products p ON i.product_id = p.id
        LEFT JOIN locations l ON i.location_id = l.id
        ORDER BY t.id DESC
      `);
      return { status: 'ok', success: true, data: res.rows };
    }
    const enrichedTags = memoryStore.tags.map((t) => ({
      ...t,
      epc_code: t.epc,
      location_code: t.rack_name,
      last_seen_at: new Date().toISOString(),
    }));
    return { status: 'ok', success: true, data: enrichedTags };
  };
  app.get('/api/tags', getTagsHandler);
  app.get('/api/rfid/tags', getTagsHandler);

  // 6. POST Encode Tag RFID Baru & Tautkan ke SKU (Mendukung /api/tags/encode dan /api/rfid/encode)
  const encodeTagHandler = async (request: any, reply: any) => {
    const body = (request.body || {}) as {
      product_id?: number;
      sku?: string;
      type?: 'STANDARD_LABEL' | 'ON_METAL' | 'HARD_TAG';
      epc_custom?: string;
      epc_code?: string;
      location_code?: string;
    };

    const randHex = Math.floor(1000 + Math.random() * 9000).toString(16).toUpperCase();
    const epc = body.epc_custom || body.epc_code || `E280-1160-2000-${randHex}`;
    const type = body.type || 'STANDARD_LABEL';

    const prod = body.product_id
      ? memoryStore.products.find((p) => p.id === Number(body.product_id))
      : memoryStore.products.find((p) => p.sku === body.sku) || memoryStore.products[0];

    if (isPostgresConnected && prod) {
      const tagRes = await db.query(
        `INSERT INTO tags (epc, type, status) VALUES ($1, $2, 'ENCODED') RETURNING *`,
        [epc, type]
      );
      const itemRes = await db.query(
        `INSERT INTO items (product_id, tag_id) VALUES ($1, $2) RETURNING *`,
        [prod.id, tagRes.rows[0].id]
      );
      publishRealtimeEvent('wms/tags/encoded', { epc, product_id: prod.id, status: 'ENCODED' });
      return reply.code(201).send({
        status: 'ok',
        success: true,
        tag: tagRes.rows[0],
        item: itemRes.rows[0],
        data: tagRes.rows[0],
      });
    }

    const newTag = {
      id: memoryStore.tags.length + 1,
      epc,
      epc_code: epc,
      type,
      status: 'IN_STOCK',
      last_rssi: '-52 dBm',
      sku: prod?.sku || body.sku || 'SKU-012',
      product_name: prod?.name || 'Barang Gudang',
      rack_name: body.location_code || 'Rak A1-01',
      location_code: body.location_code || 'Rak A1-01',
    };
    memoryStore.tags.unshift(newTag);
    publishRealtimeEvent('wms/tags/encoded', { epc, product_id: prod?.id || 1, status: 'ENCODED' });

    return reply.code(201).send({
      status: 'ok',
      success: true,
      message: `Tag ${epc} berhasil di-encode!`,
      tag: newTag,
      data: newTag,
      item: { product_id: prod?.id || 1, tag_id: newTag.id },
    });
  };
  app.post('/api/tags/encode', encodeTagHandler);
  app.post('/api/rfid/encode', encodeTagHandler);
}
