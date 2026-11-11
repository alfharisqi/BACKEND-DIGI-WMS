import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { db, isPostgresConnected, memoryStore } from '../../config/db';
import { publishRealtimeEvent } from '../../config/mqtt';
import { MemoryRepository, PostgresRepository, Repository } from './repository';
import { InboundService } from './service';
import { body, id, InboundError, Row, text } from './validation';

// Optional dependencies let tests use isolated stores and a real, isolated PostgreSQL pool.
export interface InboundOptions { repository?: Repository; publish?: (topic: string, payload: Row) => void; }
const memoryRepository = new MemoryRepository(memoryStore);
const postgresRepository = new PostgresRepository(db);
export async function orang1InboundRoutes(app: FastifyInstance, options: InboundOptions = {}) {
  const service = () => new InboundService(options.repository ?? (isPostgresConnected ? postgresRepository : memoryRepository), options.publish ?? publishRealtimeEvent);
  const run = (handler: (s: InboundService, r: FastifyRequest) => Promise<unknown>, created = false) => async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const data = await handler(service(), request);
      // Preserve encode's legacy tag/item fields while offering the common data envelope.
      const legacy = request.method === 'POST' && ['/api/tags/encode', '/api/rfid/encode'].includes(request.url.split('?')[0]) ? data as Row : {};
      return reply.code(created ? 201 : 200).send({ ...legacy, status: 'ok', success: true, message: created ? 'Data berhasil disimpan.' : 'Operasi berhasil.', data });
    } catch (error) {
      if (error instanceof InboundError) return reply.code(error.status).send({ success: false, message: error.message });
      const code = (error as { code?: string }).code;
      const known: Record<string, [number, string]> = {
        '23505': [409, 'SKU, nomor PO, atau EPC sudah terdaftar.'],
        '23503': [409, 'Data memiliki relasi transaksi atau referensi tidak tersedia.'],
        '23514': [400, 'Nilai tidak sesuai aturan database.'],
        '22P02': [400, 'Format ID atau nilai enum tidak sesuai skema aktif.'],
        '22001': [400, 'Teks terlalu panjang untuk skema database.'],
        '40P01': [409, 'Transaksi bersamaan; muat ulang data dan coba lagi.'],
        '55P03': [409, 'Data sedang diproses transaksi lain; coba lagi.'],
      };
      if (code && known[code]) return reply.code(known[code][0]).send({ success: false, message: known[code][1] });
      request.log.error({ err: error }, 'Operasi Orang 1 gagal');
      return reply.code(500).send({ success: false, message: 'Operasi gagal disimpan. Periksa koneksi atau kompatibilitas skema database.' });
    }
  };
  const param = (r: FastifyRequest) => id((r.params as { id: string }).id);
  app.get('/api/products', run(s => s.products()));
  app.get('/api/products/:id', run(async (s, r) => (await s.products(param(r)))[0]));
  app.post('/api/products', run((s, r) => s.saveProduct(body(r.body)), true));
  app.put('/api/products/:id', run((s, r) => s.saveProduct(body(r.body), param(r))));
  app.delete('/api/products/:id', run((s, r) => s.deleteProduct(param(r))));
  app.get('/api/inbound/grn', run(s => s.grns()));
  app.get('/api/inbound/grn/:id', run((s, r) => s.grns(param(r))));
  app.post('/api/inbound/grn', run((s, r) => s.saveGrn(body(r.body)), true));
  app.put('/api/inbound/grn/:id', run((s, r) => s.saveGrn(body(r.body), param(r))));
  app.patch('/api/inbound/grn/:id/verify', run((s, r) => s.verifyGrn(param(r))));
  app.patch('/api/inbound/grn/:id/cancel', run((s, r) => s.cancelGrn(param(r), body(r.body))));
  app.get('/api/tags', run(s => s.tags()));
  // Preserve main's RFID URL for existing clients while sharing validated business rules.
  app.get('/api/rfid/tags', run(s => s.tags()));
  app.get('/api/tags/:id', run((s, r) => s.tags(param(r))));
  app.post('/api/tags/encode', run((s, r) => s.encode(body(r.body)), true));
  app.post('/api/rfid/encode', run(async (s, r) => {
    const input = body(r.body);
    let productId = input.product_id;
    if (productId === undefined) {
      const sku = text(input.sku, 'SKU', 50);
      const product = (await s.products()).find(row => row.sku === sku);
      if (!product) throw new InboundError(404, 'SKU tidak ditemukan; produk tidak diganti dengan data lain.');
      productId = product.id;
    }
    // Legacy location_code never performs putaway or declares physical encoding success.
    return s.encode({ ...input, product_id: productId, epc_custom: input.epc_custom ?? input.epc_code });
  }, true));
  app.patch('/api/tags/:id', run((s, r) => s.updateTag(param(r), body(r.body))));
  app.patch('/api/tags/:id/deactivate', run((s, r) => s.deactivateTag(param(r), body(r.body))));
}
