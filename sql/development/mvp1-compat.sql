-- Add the tables and columns used by the current MVP 1 routes to the synthetic UUID fixture.
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;

ALTER TABLE users ADD COLUMN username TEXT NOT NULL UNIQUE,
  ADD COLUMN email TEXT NOT NULL UNIQUE, ADD COLUMN password_hash TEXT NOT NULL,
  ADD COLUMN full_name TEXT NOT NULL, ADD COLUMN role TEXT NOT NULL,
  ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT true, ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE TABLE audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL, payload JSONB NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE locations ADD COLUMN location_type TEXT NOT NULL DEFAULT 'RACK'
  CHECK (location_type IN ('RACK','PACKING_STATION','TRANSIT')), ADD UNIQUE (code);
ALTER TABLE stock_movements ADD COLUMN from_location_id UUID REFERENCES locations(id) ON DELETE SET NULL,
  ADD COLUMN to_location_id UUID REFERENCES locations(id) ON DELETE SET NULL;

CREATE TABLE stocktake_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), session_code TEXT NOT NULL UNIQUE, zone_code TEXT NOT NULL,
  scanner_device TEXT, total_expected INT NOT NULL DEFAULT 0, total_scanned INT NOT NULL DEFAULT 0,
  matched_count INT NOT NULL DEFAULT 0, missing_count INT NOT NULL DEFAULT 0, misplaced_count INT NOT NULL DEFAULT 0,
  discrepancies JSONB NOT NULL DEFAULT '[]', status TEXT NOT NULL,
  conducted_by UUID REFERENCES users(id), approved_by UUID REFERENCES users(id), approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE VIEW v_product_stock_ledger AS
SELECT p.id AS product_id, p.sku, p.name AS product_name, p.category, p.min_stock_threshold,
  COALESCE(SUM(m.qty_change), 0)::int AS current_stock,
  CASE WHEN COALESCE(SUM(m.qty_change), 0) <= p.min_stock_threshold THEN 'STOK_RENDAH' ELSE 'AMAN' END AS stock_status
FROM products p LEFT JOIN stock_movements m ON m.product_id = p.id OR (m.product_id IS NULL AND m.sku = p.sku)
GROUP BY p.id;

CREATE FUNCTION dev_validate_rack_capacity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE rack locations%ROWTYPE;
BEGIN
  IF NEW.location_id IS NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND NEW.location_id IS NOT DISTINCT FROM OLD.location_id THEN RETURN NEW; END IF;
  SELECT * INTO rack FROM locations WHERE id=NEW.location_id FOR UPDATE;
  IF rack.location_type = 'RACK' AND (SELECT count(*) FROM items WHERE location_id=rack.id) >= rack.max_capacity THEN
    RAISE EXCEPTION 'Rak Development penuh.';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION dev_refresh_rack_capacity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE before_id UUID;
DECLARE after_id UUID;
BEGIN
  IF TG_OP <> 'INSERT' THEN before_id := OLD.location_id; END IF;
  IF TG_OP <> 'DELETE' THEN after_id := NEW.location_id; END IF;
  UPDATE locations l SET current_items_count=u.qty,
    capacity_status=CASE WHEN u.qty::numeric/l.max_capacity < 0.5 THEN 'Longgar'
                         WHEN u.qty::numeric/l.max_capacity < 0.8 THEN 'Optimal' ELSE 'Padat' END,
    updated_at=now()
  FROM (SELECT target.id, count(i.id)::int AS qty FROM locations target
    LEFT JOIN items i ON i.location_id=target.id WHERE target.id IN (before_id, after_id) GROUP BY target.id) u
  WHERE l.id=u.id;
  RETURN NULL;
END $$;

CREATE TRIGGER dev_validate_rack BEFORE INSERT OR UPDATE OF location_id ON items
  FOR EACH ROW EXECUTE FUNCTION dev_validate_rack_capacity();
CREATE TRIGGER dev_refresh_rack AFTER INSERT OR DELETE OR UPDATE OF location_id ON items
  FOR EACH ROW EXECUTE FUNCTION dev_refresh_rack_capacity();
