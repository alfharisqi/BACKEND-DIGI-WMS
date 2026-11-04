-- ============================================================================
-- DIGI WMS: Orang 4 Dashboard & Supabase Compatibility Migration
-- Views, User Authentication columns & Audit Logs adjustments
-- ============================================================================

-- 1. Ensure username and password_hash in users table (Bcrypt Hash)
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS username text;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS password_hash text;

-- Drop plain text password column permanently for security
ALTER TABLE public.users DROP COLUMN IF EXISTS password;

-- Default password hash for existing users: $2b$10$d1.oqA8VE4yah4LNHPT93Ocho6tmG2fdpUNrp/yVwWziVuoiEL6Ne ('123456')
UPDATE public.users 
SET 
    username = COALESCE(username, split_part(email, '@', 1)),
    password_hash = COALESCE(password_hash, '$2b$10$d1.oqA8VE4yah4LNHPT93Ocho6tmG2fdpUNrp/yVwWziVuoiEL6Ne');

-- 2. Audit logs payload column & default entity_type
ALTER TABLE public.audit_logs ADD COLUMN IF NOT EXISTS payload jsonb;
ALTER TABLE public.audit_logs ALTER COLUMN entity_type DROP NOT NULL;
ALTER TABLE public.audit_logs ALTER COLUMN entity_type SET DEFAULT 'SYSTEM';

-- 3. View v_product_stock_ledger for Live Dashboard KPI & Stock Ledger
CREATE OR REPLACE VIEW public.v_product_stock_ledger AS
SELECT 
    p.id AS product_id,
    p.sku,
    p.name AS product_name,
    p.category,
    COALESCE(p.min_stock_threshold, 20) AS min_stock_alert,
    COALESCE(p.current_stock, 0)::INT AS current_stock,
    CASE 
        WHEN COALESCE(p.current_stock, 0) <= COALESCE(p.min_stock_threshold, 20) THEN 'STOK_RENDAH'
        ELSE 'AMAN'
    END AS stock_status
FROM public.products p
ORDER BY p.name ASC;
