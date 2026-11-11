// Disposable in-process fixtures for browser QA. No production database or broker writes.
// Frontend: set VITE_API_URL=http://127.0.0.1:5001/api only in the test process.
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { orang1InboundRoutes } from '../src/modules/orang1-inbound/routes';
import { MemoryRepository } from '../src/modules/orang1-inbound/repository';
import { orang4DashboardRoutes } from '../src/modules/orang4-dashboard/routes';
import { createSupabaseQa } from './qa-supabase';

async function main() {
  const app = Fastify();
  const source = {
    products: [{ id: '18b635db-0ec3-41b1-a1ec-e15da1438ce2', sku: 'QA-UUID-001', name: 'Keyboard QA UUID', category: 'Periferal Gaming', price: 650000, min_stock_alert: 20 }],
    goods_receipts: [], tags: [], items: [], stock_movements: [], gate_events: [],
  };
  await app.register(cors, { origin: true });
  const postgresQa = process.env.ORANG1_TEST_DATABASE_URL ? await createSupabaseQa(true) : null;
  await app.register(orang1InboundRoutes, { repository: postgresQa?.repository ?? new MemoryRepository(source), publish: () => {} });
  await app.register(orang4DashboardRoutes);
  await app.listen({ port: 5001, host: '127.0.0.1' });
  console.log(`Isolated browser QA API http://127.0.0.1:5001/api (${postgresQa ? 'disposable PostgreSQL / expanded QA status capabilities' : 'memory'}, MQTT spy)`);
  const stop = async () => { await app.close(); await postgresQa?.close(); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
