-- Migrasi 005: Tabel Master Box / Karton (Box-Level Tagging & Break-Pack)
CREATE TABLE IF NOT EXISTS boxes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  box_code TEXT UNIQUE NOT NULL,
  master_epc TEXT UNIQUE NOT NULL,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  qty_per_box INTEGER NOT NULL CHECK (qty_per_box > 0),
  location_id UUID REFERENCES locations(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'SEALED' CHECK (status IN ('SEALED', 'IN_RACK', 'UNPACKED', 'SHIPPED')),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  unpacked_at TIMESTAMPTZ
);
