import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { warehouseSession } from '../warehouse-session';
import { db } from '../../config/db';
import { PickingError, checklistInput, orderIdInput, packingRevision, scanInput, statusInput } from './contract';
import { PackingRepository } from './packing';
import { PickingRepository } from './repository';

function pickingSession(request: FastifyRequest) {
  return warehouseSession(request.headers.authorization, (status, message) => { throw new PickingError(status, message); });
}

function failure(request: FastifyRequest, reply: FastifyReply, error: unknown) {
  if (error instanceof PickingError) {
    return reply.code(error.statusCode).send({ success: false, message: error.message });
  }
  const code = (error as { code?: string }).code ?? '';
  if (['23505', '23503', '40P01', '40001', '55P03'].includes(code)) {
    return reply.code(409).send({ success: false, message: 'Reservasi berbenturan dengan transaksi lain. Muat ulang data sebelum mencoba lagi.' });
  }
  if (code.startsWith('08') || ['42P01', '42703', '42501', '57P01', '53300', 'ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET'].includes(code)
      || (error instanceof Error && /timeout|connection terminated/i.test(error.message))) {
    request.log.warn({ code }, 'Dependency Picking tidak tersedia');
    return reply.code(503).send({ success: false, message: 'Database atau skema Picking belum tersedia. Coba lagi setelah layanan siap.' });
  }
  request.log.error({ code }, 'Operasi Picking gagal');
  return reply.code(500).send({ success: false, message: 'Operasi Picking gagal. Muat ulang pesanan untuk memeriksa status terakhir.' });
}

interface PickingOptions {
  repository?: PickingRepository;
  packing?: PackingRepository;
}

export async function orang1PickingRoutes(app: FastifyInstance, options: PickingOptions = {}) {
  const repository = options.repository ?? new PickingRepository(db);
  const packing = options.packing ?? new PackingRepository(db);
  app.get('/api/picking/orders', async (request, reply) => {
    try {
      const session = pickingSession(request);
      const data = await repository.orders(statusInput(request.query), session);
      return { success: true, message: 'Daftar pesanan picking.', data };
    } catch (error) {
      return failure(request, reply, error);
    }
  });
  app.post('/api/picking/orders', async (request, reply) => {
    try {
      const session = pickingSession(request);
      const body = (request.body ?? {}) as {
        order_number?: string;
        lines?: Array<{ product_id?: string; requested_qty?: number }>;
      };
      const orderNumber = String(body.order_number ?? '').trim();
      const lines = Array.isArray(body.lines) ? body.lines : [];
      if (!orderNumber || orderNumber.length > 80) {
        throw new PickingError(400, 'Nomor pesanan picking wajib diisi (maks 80 karakter).');
      }
      if (!lines.length) {
        throw new PickingError(400, 'Minimal 1 baris produk/SKU wajib dipilih untuk pesanan picking.');
      }
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        const orderRes = await client.query(
          `INSERT INTO public.picking_orders (order_number, status)
           VALUES ($1, 'MENUNGGU_PICKING')
           RETURNING id`,
          [orderNumber]
        );
        const orderId = orderRes.rows[0].id;
        for (const l of lines) {
          const qty = Number(l.requested_qty ?? 1);
          if (!l.product_id || !Number.isInteger(qty) || qty <= 0) {
            throw new PickingError(400, 'Pilih produk dan jumlah unit yang valid (> 0).');
          }
          await client.query(
            `INSERT INTO public.picking_order_lines (order_id, product_id, requested_qty)
             VALUES ($1, $2, $3)`,
            [orderId, l.product_id, qty]
          );
        }
        await client.query('COMMIT');
        const allOrders = await repository.orders(null, session);
        const created = allOrders.find((o: any) => o.id === orderId) || { id: orderId, order_number: orderNumber };
        return reply.code(201).send({
          success: true,
          message: `Pesanan picking ${orderNumber} berhasil dibuat!`,
          data: created,
        });
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    } catch (error) {
      return failure(request, reply, error);
    }
  });
  app.post('/api/picking/scan', async (request, reply) => {
    try {
      const session = pickingSession(request);
      const { orderId, epc } = scanInput(request.body);
      const data = await repository.reserve(orderId, epc, session);
      return { success: true, message: 'EPC cocok. Tag dan item berhasil direservasi.', data };
    } catch (error) {
      return failure(request, reply, error);
    }
  });
  app.get<{ Params: { orderId: string } }>('/api/picking/orders/:orderId/packing', async (request, reply) => {
    try {
      const session = pickingSession(request);
      const data = await packing.details(orderIdInput(request.params.orderId), session);
      return { success: true, message: 'Detail pesanan dan Packing.', data };
    } catch (error) { return failure(request, reply, error); }
  });
  app.patch<{ Params: { orderId: string } }>('/api/picking/orders/:orderId/packing-checklist', async (request, reply) => {
    try {
      const session = pickingSession(request);
      const orderId = orderIdInput(request.params.orderId);
      const data = await packing.change(orderId, session, { action: 'CHECKLIST_SAVED', ...checklistInput(request.body) });
      return { success: true, message: 'Checklist Packing tersimpan.', data };
    } catch (error) { return failure(request, reply, error); }
  });
  app.post<{ Params: { orderId: string } }>('/api/picking/orders/:orderId/packing-complete', async (request, reply) => {
    try {
      const session = pickingSession(request);
      const orderId = orderIdInput(request.params.orderId);
      const data = await packing.change(orderId, session, { action: 'PACKING_COMPLETED', revision: packingRevision(request.body) });
      return { success: true, message: 'Packing selesai.', data };
    } catch (error) { return failure(request, reply, error); }
  });
}
