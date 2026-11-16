import Fastify from 'fastify';
import cors from '@fastify/cors';
import dotenv from 'dotenv';
import path from 'path';
import { checkDatabaseConnection } from './config/db';
import { initMqttClient } from './config/mqtt';
import { orang1InboundRoutes } from './modules/orang1-inbound/routes';
import { orang2InventoryRoutes } from './modules/orang2-inventory/routes';
import { orang3OpnameRoutes } from './modules/orang3-opname/routes';
import { orang4DashboardRoutes } from './modules/orang4-dashboard/routes';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const app = Fastify({ logger: false });
const PORT = Number(process.env.PORT) || 5000;

async function bootstrap() {
  // 1. Aktifkan CORS agar Frontend Web & Handheld App bisa mengakses API
  await app.register(cors, { origin: true });

  // Root & Favicon handler agar tidak muncul 404 saat diakses langsung dari browser
  app.get('/', async () => ({
    status: 'OK',
    service: 'DIGI WMS Backend API Server',
    docs: '/api/health',
  }));
  app.get('/favicon.ico', async (_req, reply) => reply.code(204).send());

  // 2. Daftarkan 4 Modul Tim (Vertical Slicing)
  await app.register(orang1InboundRoutes);   // Orang 1: Master SKU, Tagging & Inbound GRN
  await app.register(orang2InventoryRoutes); // Orang 2: Rak, Putaway & Stock Movement Ledger
  await app.register(orang3OpnameRoutes);    // Orang 3: Sesi Opname Handheld & Rekonsiliasi
  await app.register(orang4DashboardRoutes); // Orang 4: Health Check, Dashboard KPI & Users

  // 3. Cek Koneksi Database PostgreSQL & Inisialisasi Broker EMQX
  await checkDatabaseConnection();
  initMqttClient();

  // 4. Jalankan HTTP Server
  await app.listen({ port: PORT, host: '0.0.0.0' });
  console.log('==============================================================');
  console.log(`🚀 DIGI WMS Backend API Aktif di: http://localhost:${PORT}`);
  console.log(`📡 Cek Status Sistem         : http://localhost:${PORT}/api/health`);
  console.log('==============================================================');
}

bootstrap().catch((err) => {
  console.error('Gagal menjalankan server DIGI WMS:', err);
  process.exit(1);
});
