-- =============================================================================
-- SKEMA DATABASE UTAMA DIGI WMS (POSTGRESQL) - TAHAP 1 PONDASI
-- Prinsip Data: Append-Only Stock Movement Ledger (Tidak menimpa angka stok)
-- =============================================================================

-- Ekstensi UUID jika diperlukan
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =============================================================================
-- [BAGIAN ORANG 4] MASTER PENGGUNA, AUTENTIKASI & AUDIT LOG
-- =============================================================================
CREATE TYPE user_role AS ENUM ('ADMIN', 'SUPERVISOR', 'WAREHOUSE_STAFF', 'CASHIER', 'SECURITY');

CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(50) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    full_name VARCHAR(100) NOT NULL,
    role user_role NOT NULL DEFAULT 'WAREHOUSE_STAFF',
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE audit_logs (
    id SERIAL PRIMARY KEY,
    user_id INT REFERENCES users(id) ON DELETE SET NULL,
    action VARCHAR(100) NOT NULL,
    payload JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- =============================================================================
-- [BAGIAN ORANG 1] MASTER PRODUK (SKU), TAG RFID (EPC) & INBOUND (GRN)
-- =============================================================================
CREATE TABLE products (
    id SERIAL PRIMARY KEY,
    sku VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(150) NOT NULL,
    category VARCHAR(100) NOT NULL,
    min_stock_alert INT DEFAULT 20,
    price DECIMAL(12,2) NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TYPE tag_status AS ENUM (
    'UNASSIGNED',       -- 1. Belum dipakai
    'ENCODED',          -- 2. Ter-encode di meja penerimaan
    'IN_STOCK',         -- 3. Sudah diletakkan di rak (Putaway)
    'RESERVED',         -- 4. Sedang di-picking / keranjang POS
    'AUTHORIZED_OUT',   -- 5. Memiliki Gate Pass sah untuk keluar gerbang
    'EXITED',           -- 6. Sudah keluar gerbang / terjual
    'DAMAGED'           -- 7. Tag rusak / diganti
);

CREATE TYPE tag_type AS ENUM ('STANDARD_LABEL', 'ON_METAL', 'HARD_TAG');

CREATE TABLE tags (
    id SERIAL PRIMARY KEY,
    epc VARCHAR(64) UNIQUE NOT NULL,          -- Kode unik 96-bit Hex (920-923 MHz)
    type tag_type NOT NULL DEFAULT 'STANDARD_LABEL',
    status tag_status NOT NULL DEFAULT 'UNASSIGNED',
    last_rssi VARCHAR(20) DEFAULT '-55 dBm',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE goods_receipts (
    id SERIAL PRIMARY KEY,
    po_number VARCHAR(50) UNIQUE NOT NULL,
    supplier_name VARCHAR(150) NOT NULL,
    receipt_date DATE NOT NULL DEFAULT CURRENT_DATE,
    total_qty INT NOT NULL,
    rfid_tagging_status VARCHAR(50) DEFAULT 'MENUNGGU_TAGGING',
    status VARCHAR(30) DEFAULT 'MENUNGGU_VERIFIKASI', -- 'MENUNGGU_VERIFIKASI' atau 'SELESAI'
    received_by INT REFERENCES users(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- =============================================================================
-- [BAGIAN ORANG 2] MASTER LOKASI RAK, UNIT ITEM & BUKU BESAR STOK (LEDGER)
-- =============================================================================
CREATE TABLE locations (
    id SERIAL PRIMARY KEY,
    zone_code VARCHAR(10) UNIQUE NOT NULL,    -- Contoh: 'A1', 'A2', 'B1'
    rack_name VARCHAR(50) NOT NULL,           -- Contoh: 'Rak A1-01'
    zone_description VARCHAR(100) NOT NULL,   -- Contoh: 'Zona Aksesoris A'
    max_capacity INT NOT NULL DEFAULT 500,
    status VARCHAR(20) DEFAULT 'OPTIMAL'      -- 'OPTIMAL', 'PADAT', 'LONGGAR'
);

-- Tabel penghubung: 1 Unit Barang Fisik = 1 Tag RFID
CREATE TABLE items (
    id SERIAL PRIMARY KEY,
    product_id INT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    tag_id INT UNIQUE REFERENCES tags(id) ON DELETE SET NULL,
    location_id INT REFERENCES locations(id) ON DELETE SET NULL,
    grn_id INT REFERENCES goods_receipts(id) ON DELETE SET NULL,
    serial_number VARCHAR(100),
    is_asset BOOLEAN DEFAULT FALSE,           -- FALSE = Inventori Dagang, TRUE = Aset Kantor
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TYPE movement_type AS ENUM (
    'INBOUND_GRN',
    'PUTAWAY',
    'PICKING',
    'OUTBOUND_SHIPMENT',
    'POS_SALE',
    'STOCKTAKE_ADJUSTMENT',
    'INTERNAL_TRANSFER',
    'RETURN_RESTOCK'
);

-- BUKU BESAR MUTASI STOK (APPEND-ONLY / IMMUTABLE LEDGER)
CREATE TABLE stock_movements (
    id SERIAL PRIMARY KEY,
    tx_code VARCHAR(30) UNIQUE NOT NULL,      -- Contoh: 'TX-1001'
    movement_type movement_type NOT NULL,
    product_id INT NOT NULL REFERENCES products(id),
    item_id INT REFERENCES items(id),
    from_location VARCHAR(60) NOT NULL,
    to_location VARCHAR(60) NOT NULL,
    qty INT NOT NULL,                         -- Positif (+) masuk, Negatif (-) keluar
    reference_doc VARCHAR(50),                -- No PO, No Resi, atau Kode Sesi Opname
    operator_id INT REFERENCES users(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- VIEW OTOMATIS: Menghitung Stok Aktual per SKU & Rak dari Ledger Mutasi
CREATE OR REPLACE VIEW v_product_stock_ledger AS
SELECT 
    p.id AS product_id,
    p.sku,
    p.name AS product_name,
    p.category,
    p.min_stock_alert,
    COALESCE(SUM(sm.qty), 0)::INT AS current_stock,
    CASE 
        WHEN COALESCE(SUM(sm.qty), 0) <= p.min_stock_alert THEN 'STOK_RENDAH'
        ELSE 'AMAN'
    END AS stock_status
FROM products p
LEFT JOIN stock_movements sm ON p.id = sm.product_id
GROUP BY p.id, p.sku, p.name, p.category, p.min_stock_alert
ORDER BY p.id ASC;

-- =============================================================================
-- [BAGIAN ORANG 3] SESI STOCK OPNAME HANDHELD RFID (CYCLE COUNT)
-- =============================================================================
CREATE TABLE stocktake_sessions (
    id SERIAL PRIMARY KEY,
    session_code VARCHAR(50) UNIQUE NOT NULL, -- Contoh: 'OPN-2026-A1'
    zone_code VARCHAR(10) NOT NULL REFERENCES locations(zone_code),
    total_expected INT NOT NULL DEFAULT 0,
    total_scanned INT NOT NULL DEFAULT 0,
    total_matched INT NOT NULL DEFAULT 0,
    total_missing INT NOT NULL DEFAULT 0,
    total_misplaced INT NOT NULL DEFAULT 0,
    status VARCHAR(30) DEFAULT 'DRAFT',       -- 'DRAFT', 'MENUNGGU_APPROVAL', 'DISETUJUI'
    scanned_by INT REFERENCES users(id),
    approved_by INT REFERENCES users(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE stocktake_discrepancies (
    id SERIAL PRIMARY KEY,
    session_id INT NOT NULL REFERENCES stocktake_sessions(id) ON DELETE CASCADE,
    product_id INT NOT NULL REFERENCES products(id),
    expected_rack VARCHAR(50) NOT NULL,
    system_qty INT NOT NULL,
    scanned_qty INT NOT NULL,
    diff_qty INT NOT NULL,
    diagnosis VARCHAR(150) NOT NULL,          -- 'COCOK', 'HILANG', 'SALAH_RAK'
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- =============================================================================
-- [SIAP PAKAI UNTUK FASE 2, 3 & 4] POS, GATE PASS, ALARM GERBANG & ASET
-- =============================================================================
CREATE TABLE sales (
    id SERIAL PRIMARY KEY,
    invoice_number VARCHAR(50) UNIQUE NOT NULL,
    total_amount DECIMAL(12,2) NOT NULL,
    payment_method VARCHAR(30) NOT NULL,
    cashier_id INT REFERENCES users(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE gate_passes (
    id SERIAL PRIMARY KEY,
    pass_number VARCHAR(50) UNIQUE NOT NULL,  -- Contoh: 'GP-8839-OK'
    reference_type VARCHAR(30) NOT NULL,      -- 'POS_SALE' atau 'OUTBOUND_SHIPMENT'
    reference_doc VARCHAR(50) NOT NULL,
    destination VARCHAR(150),
    courier VARCHAR(50),
    is_valid BOOLEAN DEFAULT TRUE,
    issued_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE gate_events (
    id SERIAL PRIMARY KEY,
    gate_id VARCHAR(30) NOT NULL DEFAULT 'GATE-01',
    epc VARCHAR(64) NOT NULL,
    product_name VARCHAR(150),
    antenna_info VARCHAR(50) NOT NULL,
    rssi_dbm INT NOT NULL,
    is_authorized BOOLEAN NOT NULL,
    action_taken VARCHAR(100) NOT NULL,
    event_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE alarms (
    id SERIAL PRIMARY KEY,
    gate_event_id INT REFERENCES gate_events(id) ON DELETE CASCADE,
    alarm_level VARCHAR(20) DEFAULT 'CRITICAL',
    is_silenced BOOLEAN DEFAULT FALSE,
    silenced_by INT REFERENCES users(id),
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE assets (
    id SERIAL PRIMARY KEY,
    item_id INT REFERENCES items(id),
    asset_code VARCHAR(50) UNIQUE NOT NULL,
    asset_name VARCHAR(150) NOT NULL,
    current_holder VARCHAR(100),
    loan_status VARCHAR(30) DEFAULT 'AVAILABLE',
    last_serviced_at DATE,
    notes TEXT
);

-- =============================================================================
-- SEED DATA AWAL (Agar ke-4 anggota tim langsung punya data saat testing)
-- =============================================================================

-- 1. Seed Users (Orang 4)
INSERT INTO users (username, password_hash, full_name, role) VALUES
('sarah.jenkins', '$2b$10$dummyhashsupervisor', 'Sarah Jenkins', 'SUPERVISOR'),
('admin.wms', '$2b$10$dummyhashadmin', 'Budi Santoso (Admin)', 'ADMIN'),
('operator.inbound', '$2b$10$dummyhashstaff', 'Andi Pratama (Inbound)', 'WAREHOUSE_STAFF'),
('security.gate', '$2b$10$dummyhashsec', 'Komandan Hendra (Gate)', 'SECURITY');

-- 2. Seed Locations / Zona Rak (Orang 2)
INSERT INTO locations (zone_code, rack_name, zone_description, max_capacity, status) VALUES
('A1', 'Rak A1-01', 'Zona Aksesoris A', 500, 'OPTIMAL'),
('A2', 'Rak A2-04', 'Zona Aksesoris B', 500, 'OPTIMAL'),
('B1', 'Rak B1-01', 'Zona Periferal Gaming A', 700, 'PADAT'),
('B2', 'Rak B2-01', 'Zona Periferal Gaming B', 600, 'OPTIMAL'),
('C1', 'Rak C1-01', 'Zona Kabel & Konektor', 500, 'LONGGAR'),
('C3', 'Rak C3-02', 'Zona Kabel & Konektor B', 500, 'LONGGAR'),
('D1', 'Rak D1-01', 'Zona Heavy Logistics', 900, 'OPTIMAL'),
('D2', 'Rak D2-01', 'Zona Transit Inbound', 500, 'LONGGAR');

-- 3. Seed Products / SKU (Orang 1)
INSERT INTO products (sku, name, category, min_stock_alert, price) VALUES
('SKU-012', 'Mouse Wireless Ergonomic', 'Aksesoris Komputer', 20, 185000),
('SKU-018', 'Keyboard Mechanical RGB', 'Periferal Gaming', 20, 650000),
('SKU-024', 'Kabel HDMI 2.0 4K Ultra', 'Kabel & Konektor', 20, 95000),
('SKU-031', 'USB Hub Type-C 7in1 Multi', 'Aksesoris Komputer', 20, 275000),
('SKU-042', 'Gaming Headset 7.1 Surround', 'Periferal Gaming', 20, 520000),
('SKU-055', 'SSD External 1TB NVMe Pro', 'Aksesoris Komputer', 20, 1450000);

-- 4. Seed Goods Receipts / GRN (Orang 1)
INSERT INTO goods_receipts (po_number, supplier_name, receipt_date, total_qty, rfid_tagging_status, status, received_by) VALUES
('PO-2026-8901', 'PT Logitech Indonesia', '2026-05-12', 150, 'Semua Ter-encode', 'SELESAI', 1),
('PO-2026-8902', 'CV Corsair Global', '2026-05-12', 85, 'Semua Ter-encode', 'SELESAI', 1),
('PO-2026-8903', 'PT Anker Technology', '2026-05-11', 85, 'Menunggu Tagging', 'MENUNGGU_VERIFIKASI', 3);

-- 5. Seed RFID Tags (Orang 1)
INSERT INTO tags (epc, type, status, last_rssi) VALUES
('E280-1160-2000-012A', 'STANDARD_LABEL', 'IN_STOCK', '-58 dBm'),
('E280-1160-2000-018B', 'ON_METAL', 'IN_STOCK', '-54 dBm'),
('E280-1160-2000-024C', 'STANDARD_LABEL', 'IN_STOCK', '-62 dBm'),
('E280-1160-2000-031D', 'ON_METAL', 'IN_STOCK', '-51 dBm'),
('E280-1160-2000-042E', 'STANDARD_LABEL', 'AUTHORIZED_OUT', '-55 dBm'),
('E280-1160-2000-055F', 'ON_METAL', 'AUTHORIZED_OUT', '-49 dBm');

-- 6. Seed Items (1 Tag = 1 Unit) (Orang 2)
INSERT INTO items (product_id, tag_id, location_id, grn_id, serial_number) VALUES
(1, 1, 1, 1, 'SN-LOG-0012'),
(2, 2, 4, 2, 'SN-COR-0018'),
(3, 3, 6, 1, 'SN-ANK-0024'),
(4, 4, 1, 1, 'SN-ANK-0031'),
(5, 5, 4, 2, 'SN-COR-0042'),
(6, 6, 2, 1, 'SN-LOG-0055');

-- 7. Seed Stock Movements / Buku Besar Ledger (Orang 2)
INSERT INTO stock_movements (tx_code, movement_type, product_id, item_id, from_location, to_location, qty, reference_doc, operator_id) VALUES
('TX-1001', 'INBOUND_GRN', 1, 1, 'Supplier PO-2026-8901', 'Rak A1-01', 15, 'PO-2026-8901', 1),
('TX-1002', 'INBOUND_GRN', 2, 2, 'Supplier PO-2026-8902', 'Rak B2-01', 20, 'PO-2026-8902', 1),
('TX-1003', 'INBOUND_GRN', 3, 3, 'Supplier PO-2026-8901', 'Rak C3-02', 18, 'PO-2026-8901', 1),
('TX-1004', 'PUTAWAY', 4, 4, 'Zona Transit D2', 'Rak A1-01', 25, 'PO-2026-8901', 1),
('TX-1005', 'PUTAWAY', 5, 5, 'Zona Transit D2', 'Rak B2-01', 120, 'PO-2026-8902', 1),
('TX-1006', 'PUTAWAY', 6, 6, 'Zona Transit D2', 'Rak A2-04', 85, 'PO-2026-8901', 1);
