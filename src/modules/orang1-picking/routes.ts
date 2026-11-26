import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { warehouseSession } from '../warehouse-session';
import { db } from '../../config/db';
import { PickingError, ScanRejected, cancellationInput, checklistInput, createOrderInput, orderIdInput, packingRevision, productIdInput, scanInput, statusInput } from './contract';
import { PackingRepository } from './packing';
import { PickingRepository } from './repository';

function pickingSession(request: FastifyRequest) {
  return warehouseSession(request.headers.authorization, (status, message) => { throw new PickingError(status, message); });
}

function failure(request: FastifyRequest, reply: FastifyReply, error: unknown) {
  if (error instanceof PickingError) {
    return reply.code(error.statusCode).send({ success: false, message: error.message });
  }
  const code = (error as { code?: string } | null)?.code ?? '';
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
  const repository = options.repository ?? new PickingRepository(db, {
    cancellationApproved: process.env.DIGI_WMS_PICKING_CANCELLATION_APPROVED === 'true',
  });
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
      const input = createOrderInput(request.body);
      const data = await repository.create(input, session);
      return reply.code(201).send({
        success: true, message: `Pesanan picking ${input.orderNumber} berhasil dibuat!`, data,
      });
    } catch (error) {
      return failure(request, reply, error);
    }
  });
  app.get<{ Querystring: { product_id?: string } }>('/api/picking/availability', async (request, reply) => {
    try {
      const session = pickingSession(request);
      const data = await repository.availability(productIdInput(request.query.product_id), session);
      return { success: true, message: 'Stok tersedia untuk Picking.', data };
    } catch (error) { return failure(request, reply, error); }
  });
  app.get<{ Params: { orderId: string } }>('/api/picking/orders/:orderId/available-epcs', async (request, reply) => {
    try {
      const session = pickingSession(request);
      const data = await repository.availableEpcs(orderIdInput(request.params.orderId), session);
      return { success: true, message: 'Daftar EPC tersedia untuk Picking.', data };
    } catch (error) { return failure(request, reply, error); }
  });
  app.post<{ Params: { orderId: string } }>('/api/picking/orders/:orderId/cancel', async (request, reply) => {
    try {
      const session = pickingSession(request);
      const orderId = orderIdInput(request.params.orderId);
      const data = await repository.cancel(orderId, cancellationInput(request.body), session);
      return { success: true, message: 'Pesanan picking dibatalkan.', data };
    } catch (error) { return failure(request, reply, error); }
  });
  app.post('/api/picking/scan', async (request, reply) => {
    try {
      const session = pickingSession(request);
      const { orderId, epc } = scanInput(request.body);
      const data = await repository.reserve(orderId, epc, session);
      return { success: true, message: 'EPC cocok. Tag dan item berhasil direservasi.', data };
    } catch (error) {
      if (error instanceof ScanRejected) {
        return reply.code(error.statusCode).send({ success: false, message: error.message, code: 'PICKING_SCAN_REJECTED' });
      }
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
