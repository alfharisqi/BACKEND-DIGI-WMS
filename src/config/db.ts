import { Pool } from 'pg';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

export const db = new Pool({
  connectionString:
    process.env.DATABASE_URL ||
    'postgresql://digiwms:digiwms_pass@localhost:5432/digiwms_db',
  max: 15,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

export let isPostgresConnected = false;

/**
 * In-Memory Fallback Store (Otomatis aktif jika Docker PostgreSQL belum dinyalakan)
 * Menjamin tim 4 orang tetap bisa menjalankan & mengetes seluruh API tanpa error!
 */
export const memoryStore = {
  users: [
    { id: 1, username: 'sarah.jenkins', full_name: 'Sarah Jenkins', role: 'SUPERVISOR', is_active: true, created_at: '2026-05-01T08:00:00.000Z' },
    { id: 2, username: 'admin.wms', full_name: 'Budi Santoso (Admin)', role: 'ADMIN', is_active: true, created_at: '2026-05-01T08:05:00.000Z' },
    { id: 3, username: 'operator.inbound', full_name: 'Andi Pratama (Inbound)', role: 'WAREHOUSE_STAFF', is_active: true, created_at: '2026-05-02T09:00:00.000Z' },
    { id: 4, username: 'security.gate', full_name: 'Komandan Hendra (Gate)', role: 'SECURITY', is_active: true, created_at: '2026-05-02T09:30:00.000Z' },
  ],
  audit_logs: [
    { id: 1, user_id: 2, user_name: 'Budi Santoso (Admin)', action: 'INIT_SYSTEM', payload: { role: 'ADMIN', note: 'Inisialisasi Server DIGI WMS & Broker EMQX' } as Record<string, unknown>, created_at: '2026-05-12T08:00:00.000Z' },
    { id: 2, user_id: 1, user_name: 'Sarah Jenkins', action: 'VERIFY_GRN', payload: { role: 'SUPERVISOR', po_number: 'PO-2026-8901', qty: 150, note: 'Verifikasi surat jalan PO-2026-8901 (150 unit)' } as Record<string, unknown>, created_at: '2026-05-12T09:30:00.000Z' },
    { id: 3, user_id: 1, user_name: 'Sarah Jenkins', action: 'UPDATE_RFID_SETTINGS', payload: { role: 'SUPERVISOR', rssi_threshold: '-65 dBm', freq: '920-923 MHz', note: 'Kalibrasi ambang batas RSSI gerbang ke -65 dBm' } as Record<string, unknown>, created_at: '2026-05-12T10:15:00.000Z' },
  ],
  gate_events: [] as Array<Record<string, unknown>>,
  settings: {
    warehouse_name: 'Gudang Utama DIGI WMS — Jakarta Pusat',
    rfid_frequency: '920 - 923 MHz (Standar Kominfo Indonesia)',
    gate_rssi_threshold_dbm: -65,
    dedup_window_seconds: 5,
    default_min_stock_alert: 20,
    emqx_ws_url: 'ws://localhost:8083/mqtt',
    auto_low_stock_notif: true,
    updated_at: new Date().toISOString(),
  },
  products: [
    { id: 1, sku: 'SKU-012', name: 'Mouse Wireless Ergonomic', category: 'Aksesoris Komputer', min_stock_alert: 20, price: 185000 },
    { id: 2, sku: 'SKU-018', name: 'Keyboard Mechanical RGB', category: 'Periferal Gaming', min_stock_alert: 20, price: 650000 },
    { id: 3, sku: 'SKU-024', name: 'Kabel HDMI 2.0 4K Ultra', category: 'Kabel & Konektor', min_stock_alert: 20, price: 95000 },
    { id: 4, sku: 'SKU-031', name: 'USB Hub Type-C 7in1 Multi', category: 'Aksesoris Komputer', min_stock_alert: 20, price: 275000 },
    { id: 5, sku: 'SKU-042', name: 'Gaming Headset 7.1 Surround', category: 'Periferal Gaming', min_stock_alert: 20, price: 520000 },
    { id: 6, sku: 'SKU-055', name: 'SSD External 1TB NVMe Pro', category: 'Aksesoris Komputer', min_stock_alert: 20, price: 1450000 },
  ],
  locations: [
    { id: 1, zone_code: 'A1', rack_name: 'Rak A1-01', zone_description: 'Zona Aksesoris A', max_capacity: 500, status: 'OPTIMAL', items_count: 40 },
    { id: 2, zone_code: 'A2', rack_name: 'Rak A2-04', zone_description: 'Zona Aksesoris B', max_capacity: 500, status: 'OPTIMAL', items_count: 85 },
    { id: 3, zone_code: 'B1', rack_name: 'Rak B1-01', zone_description: 'Zona Periferal Gaming A', max_capacity: 700, status: 'PADAT', items_count: 140 },
    { id: 4, zone_code: 'B2', rack_name: 'Rak B2-01', zone_description: 'Zona Periferal Gaming B', max_capacity: 600, status: 'OPTIMAL', items_count: 120 },
    { id: 5, zone_code: 'C1', rack_name: 'Rak C1-01', zone_description: 'Zona Kabel & Konektor', max_capacity: 500, status: 'LONGGAR', items_count: 18 },
    { id: 6, zone_code: 'C3', rack_name: 'Rak C3-02', zone_description: 'Zona Kabel & Konektor B', max_capacity: 500, status: 'LONGGAR', items_count: 18 },
  ],
  goods_receipts: [
    { id: 1, po_number: 'PO-2026-8901', supplier_name: 'PT Logitech Indonesia', receipt_date: '2026-05-12', total_qty: 150, rfid_tagging_status: 'Semua Ter-encode', status: 'SELESAI' },
    { id: 2, po_number: 'PO-2026-8902', supplier_name: 'CV Corsair Global', receipt_date: '2026-05-12', total_qty: 85, rfid_tagging_status: 'Semua Ter-encode', status: 'SELESAI' },
    { id: 3, po_number: 'PO-2026-8903', supplier_name: 'PT Anker Technology', receipt_date: '2026-05-11', total_qty: 85, rfid_tagging_status: 'Menunggu Tagging', status: 'MENUNGGU_VERIFIKASI' },
  ],
  tags: [
    { id: 1, epc: 'E280-1160-2000-012A', type: 'STANDARD_LABEL', status: 'IN_STOCK', last_rssi: '-58 dBm', sku: 'SKU-012', product_name: 'Mouse Wireless Ergonomic', rack_name: 'Rak A1-01' },
    { id: 2, epc: 'E280-1160-2000-018B', type: 'ON_METAL', status: 'IN_STOCK', last_rssi: '-54 dBm', sku: 'SKU-018', product_name: 'Keyboard Mechanical RGB', rack_name: 'Rak B2-01' },
    { id: 3, epc: 'E280-1160-2000-024C', type: 'STANDARD_LABEL', status: 'IN_STOCK', last_rssi: '-62 dBm', sku: 'SKU-024', product_name: 'Kabel HDMI 2.0 4K Ultra', rack_name: 'Rak C3-02' },
    { id: 4, epc: 'E280-1160-2000-031D', type: 'ON_METAL', status: 'IN_STOCK', last_rssi: '-51 dBm', sku: 'SKU-031', product_name: 'USB Hub Type-C 7in1 Multi', rack_name: 'Rak A1-01' },
    { id: 5, epc: 'E280-1160-2000-042E', type: 'STANDARD_LABEL', status: 'AUTHORIZED_OUT', last_rssi: '-55 dBm', sku: 'SKU-042', product_name: 'Gaming Headset 7.1 Surround', rack_name: 'Rak B2-01' },
    { id: 6, epc: 'E280-1160-2000-055F', type: 'ON_METAL', status: 'AUTHORIZED_OUT', last_rssi: '-49 dBm', sku: 'SKU-055', product_name: 'SSD External 1TB NVMe Pro', rack_name: 'Rak A2-04' },
  ],
  stock_movements: [
    { id: 1, tx_code: 'TX-1001', movement_type: 'INBOUND_GRN', product_id: 1, sku: 'SKU-012', product_name: 'Mouse Wireless Ergonomic', from_location: 'Supplier PO-2026-8901', to_location: 'Rak A1-01', qty: 15, reference_doc: 'PO-2026-8901', operator_name: 'Sarah Jenkins', created_at: new Date().toISOString() },
    { id: 2, tx_code: 'TX-1002', movement_type: 'INBOUND_GRN', product_id: 2, sku: 'SKU-018', product_name: 'Keyboard Mechanical RGB', from_location: 'Supplier PO-2026-8902', to_location: 'Rak B2-01', qty: 20, reference_doc: 'PO-2026-8902', operator_name: 'Sarah Jenkins', created_at: new Date().toISOString() },
    { id: 3, tx_code: 'TX-1003', movement_type: 'INBOUND_GRN', product_id: 3, sku: 'SKU-024', product_name: 'Kabel HDMI 2.0 4K Ultra', from_location: 'Supplier PO-2026-8901', to_location: 'Rak C3-02', qty: 18, reference_doc: 'PO-2026-8901', operator_name: 'Sarah Jenkins', created_at: new Date().toISOString() },
    { id: 4, tx_code: 'TX-1004', movement_type: 'PUTAWAY', product_id: 4, sku: 'SKU-031', product_name: 'USB Hub Type-C 7in1 Multi', from_location: 'Zona Transit D2', to_location: 'Rak A1-01', qty: 25, reference_doc: 'PO-2026-8901', operator_name: 'Sarah Jenkins', created_at: new Date().toISOString() },
    { id: 5, tx_code: 'TX-1005', movement_type: 'PUTAWAY', product_id: 5, sku: 'SKU-042', product_name: 'Gaming Headset 7.1 Surround', from_location: 'Zona Transit D2', to_location: 'Rak B2-01', qty: 120, reference_doc: 'PO-2026-8902', operator_name: 'Sarah Jenkins', created_at: new Date().toISOString() },
    { id: 6, tx_code: 'TX-1006', movement_type: 'PUTAWAY', product_id: 6, sku: 'SKU-055', product_name: 'SSD External 1TB NVMe Pro', from_location: 'Zona Transit D2', to_location: 'Rak A2-04', qty: 85, reference_doc: 'PO-2026-8901', operator_name: 'Sarah Jenkins', created_at: new Date().toISOString() },
  ],
  stocktake_sessions: [] as Array<Record<string, unknown>>,
};

export function getCalculatedLedgerStock() {
  return memoryStore.products.map((p) => {
    const current_stock = memoryStore.stock_movements
      .filter((m) => m.product_id === p.id)
      .reduce((acc, m) => acc + m.qty, 0);
    return {
      product_id: p.id,
      sku: p.sku,
      product_name: p.name,
      category: p.category,
      min_stock_alert: p.min_stock_alert,
      current_stock,
      stock_status: current_stock <= p.min_stock_alert ? 'STOK_RENDAH' : 'AMAN',
    };
  });
}

export async function checkDatabaseConnection(): Promise<boolean> {
  try {
    const res = await db.query('SELECT NOW() AS server_time');
    isPostgresConnected = true;
    console.log(`[PostgreSQL] Terhubung ke database pada: ${res.rows[0].server_time}`);
    return true;
  } catch {
    isPostgresConnected = false;
    console.log(
      '[Database] Docker PostgreSQL belum aktif -> Menggunakan In-Memory Ledger Store (Siap Pakai)'
    );
    return false;
  }
}
