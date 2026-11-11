-- QA ONLY. Reconstructed from read-only Production column/constraint metadata, not backup data.
-- No Production DDL is executed by this fixture. Use only the guarded qa-supabase helper.
CREATE TABLE users (id UUID PRIMARY KEY DEFAULT gen_random_uuid());
CREATE TABLE products (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), sku TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
 category TEXT NOT NULL, unit_price NUMERIC NOT NULL DEFAULT 0 CHECK(unit_price>=0),
 min_stock_threshold INT NOT NULL DEFAULT 20 CHECK(min_stock_threshold>=0), default_location_code TEXT,
 current_stock INT NOT NULL DEFAULT 0 CHECK(current_stock>=0), created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE goods_receipts (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), po_number TEXT NOT NULL UNIQUE, supplier_name TEXT NOT NULL,
 receipt_date DATE NOT NULL DEFAULT CURRENT_DATE, total_qty INT NOT NULL CHECK(total_qty>0),
 rfid_tagging_status TEXT NOT NULL DEFAULT 'Menunggu Tagging',
 status TEXT NOT NULL DEFAULT 'MENUNGGU_VERIFIKASI' CONSTRAINT qa_grn_status CHECK(status IN ('MENUNGGU_VERIFIKASI','SELESAI')),
 verified_by UUID REFERENCES users(id) ON DELETE SET NULL, verified_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE tags (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), epc TEXT NOT NULL UNIQUE,
 tag_type TEXT NOT NULL DEFAULT 'Label Biasa (UHF)' CHECK(tag_type IN ('Label Biasa (UHF)','On-Metal (Logam/Cairan)','Hard Tag (Aset)')),
 status TEXT NOT NULL DEFAULT 'UNASSIGNED' CONSTRAINT qa_tag_status CHECK(status IN ('UNASSIGNED','ENCODED','IN_STOCK','RESERVED','AUTHORIZED_OUT','EXITED')),
 last_rssi TEXT, encoded_by UUID REFERENCES users(id) ON DELETE SET NULL, encoded_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE locations (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), code TEXT NOT NULL, zone_code TEXT NOT NULL, name TEXT NOT NULL,
 max_capacity INT NOT NULL DEFAULT 500, current_items_count INT NOT NULL DEFAULT 0, capacity_status TEXT NOT NULL DEFAULT 'Longgar',
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE items (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tag_id UUID UNIQUE REFERENCES tags(id) ON DELETE RESTRICT,
 product_id UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT, location_id UUID REFERENCES locations(id) ON DELETE SET NULL,
 grn_id UUID REFERENCES goods_receipts(id) ON DELETE SET NULL, serial_number TEXT UNIQUE,
 status TEXT NOT NULL DEFAULT 'IN_STOCK' CHECK(status IN ('ENCODED','IN_STOCK','RESERVED','AUTHORIZED_OUT','EXITED','RETURNED')),
 putaway_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE stock_movements (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tx_code TEXT NOT NULL UNIQUE, movement_type TEXT NOT NULL,
 product_id UUID REFERENCES products(id) ON DELETE SET NULL, sku TEXT NOT NULL,
 tag_id UUID REFERENCES tags(id) ON DELETE SET NULL, from_location TEXT NOT NULL, to_location TEXT NOT NULL,
 qty_change INT NOT NULL, qty_label TEXT NOT NULL, reference_doc TEXT, performed_by_name TEXT NOT NULL DEFAULT 'System',
 performed_by UUID REFERENCES users(id) ON DELETE SET NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE gate_events (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), gate_id TEXT NOT NULL DEFAULT 'GATE-01', epc TEXT NOT NULL,
 tag_id UUID REFERENCES tags(id), item_name TEXT NOT NULL, antenna_info TEXT NOT NULL, rssi TEXT NOT NULL,
 direction TEXT NOT NULL DEFAULT 'OUT', authorization_status TEXT NOT NULL, action_taken TEXT NOT NULL,
 gate_pass_id UUID, event_time TIMESTAMPTZ NOT NULL DEFAULT now()
);
