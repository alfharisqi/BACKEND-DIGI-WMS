import Fastify from 'fastify';
import cors from '@fastify/cors';
import dotenv from 'dotenv';
import path from 'path';
import { checkDatabaseConnection } from './config/db';
import { initMqttClient } from './config/mqtt';
import { orang1InboundRoutes } from './modules/orang1-inbound/routes';
import { orang1PickingRoutes } from './modules/orang1-picking/routes';
import { orang2InventoryRoutes } from './modules/orang2-inventory/routes';
import { orang3OpnameRoutes } from './modules/orang3-opname/routes';
import { orang3PosRoutes } from './modules/orang3-opname/pos.routes';
import { orang4DashboardRoutes } from './modules/orang4-dashboard/routes';
import { outboundRoutes } from './modules/orang2-inventory/outbound.routes';

const isolatedDevelopment = process.env.DIGIWMS_LOCAL_DEV === '1';

if (!isolatedDevelopment) {
  dotenv.config({ path: path.resolve(__dirname, '../../.env') });
}

process.on('uncaughtException', (err) => {
  console.error('[Process Uncaught Exception]:', err.message);
});

process.on('unhandledRejection', (reason) => {
  console.error('[Process Unhandled Rejection]:', reason);
});

const app = Fastify({ logger: false });
const PORT = isolatedDevelopment ? 5102 : Number(process.env.PORT) || 5000;

async function bootstrap() {
  // 1. Aktifkan CORS agar Frontend Web & Handheld App bisa mengakses API
  if (isolatedDevelopment) {
    const origin = process.env.DIGIWMS_DEV_FRONTEND_ORIGIN;

    if (
      !origin ||
      !/^http:\/\/localhost:[0-9]+$/.test(origin) ||
      !process.env.DIGIWMS_DEV_SERVICE_ID
    ) {
      throw new Error('Jalankan backend Development melalui npm run dev pada frontend.');
    }

    app.addHook('onRequest', async (request, reply) => {
      if (request.headers.origin && request.headers.origin !== origin) {
        return reply.code(403).send({
          success: false,
          message: 'Origin frontend Development tidak dikenal.',
        });
      }
    });

    await app.register(cors, { origin });

    app.get('/api/dev/ready', async (request, reply) => {
      if (request.headers['x-digiwms-dev-probe'] !== process.env.DIGIWMS_DEV_SERVICE_ID) {
        return reply.code(404).send();
      }

      return { ready: true };
    });
  } else {
    await app.register(cors, { origin: true });
  }

  // Root & Favicon handler agar tidak muncul 404 saat diakses langsung dari browser
  app.get('/', async () => ({
    status: 'OK',
    service: 'DIGI WMS Backend API Server',
    docs: '/api/health',
  }));

  app.get('/favicon.ico', async (_req, reply) => reply.code(204).send());

  // 2. Daftarkan modul seluruh tim
  await app.register(orang1InboundRoutes); // Orang 1: Master SKU, Tagging & Inbound GRN
  await app.register(orang1PickingRoutes);
  await app.register(orang2InventoryRoutes); // Orang 2: Rak, Putaway & Stock Movement Ledger
  await app.register(orang3OpnameRoutes); // Orang 3: Sesi Opname Handheld & Rekonsiliasi
  await app.register(orang3PosRoutes); // Orang 3: Kasir POS & Modul Retur
  await app.register(orang4DashboardRoutes); // Orang 4: Health Check, Dashboard KPI & Users
  await app.register(outboundRoutes); // Orang 2: Outbound & Mutasi Stok

  // 3. Cek Koneksi Database PostgreSQL & Inisialisasi Broker EMQX
  await checkDatabaseConnection();
  if (!isolatedDevelopment) initMqttClient();

  // 4. Jalankan HTTP Server
  await app.listen({
    port: PORT,
    host: isolatedDevelopment ? '127.0.0.1' : '0.0.0.0',
  });

  console.log('==============================================================');
  console.log(`🚀 DIGI WMS Backend API Aktif di: http://localhost:${PORT}`);
  console.log(`📡 Cek Status Sistem         : http://localhost:${PORT}/api/health`);
  console.log('==============================================================');
}

bootstrap().catch((err) => {
  console.error('Gagal menjalankan server DIGI WMS:', err);
  process.exit(1);
});
