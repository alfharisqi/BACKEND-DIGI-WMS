-- Manual review only. Requires the native UUID Supabase schema.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE public.picking_orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_number TEXT NOT NULL UNIQUE CHECK (length(btrim(order_number)) BETWEEN 1 AND 80),
    status TEXT NOT NULL DEFAULT 'MENUNGGU_PICKING'
        CHECK (status IN ('MENUNGGU_PICKING', 'SEDANG_DIAMBIL', 'SIAP_PACKING')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX picking_orders_status_created_idx ON public.picking_orders (status, created_at, id);

CREATE TABLE public.picking_order_lines (
    order_id UUID NOT NULL REFERENCES public.picking_orders(id),
    product_id UUID NOT NULL REFERENCES public.products(id),
    requested_qty INTEGER NOT NULL CHECK (requested_qty > 0),
    PRIMARY KEY (order_id, product_id)
);
CREATE INDEX picking_order_lines_product_idx ON public.picking_order_lines (product_id);

CREATE TABLE public.picking_scans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL,
    product_id UUID NOT NULL,
    item_id UUID NOT NULL REFERENCES public.items(id),
    tag_id UUID NOT NULL REFERENCES public.tags(id),
    location_id UUID NOT NULL REFERENCES public.locations(id),
    epc TEXT NOT NULL,
    location_code TEXT NOT NULL,
    location_name TEXT NOT NULL,
    scanned_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    scanned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    released_at TIMESTAMPTZ CHECK (released_at >= scanned_at),
    FOREIGN KEY (order_id, product_id) REFERENCES public.picking_order_lines(order_id, product_id),
    UNIQUE (order_id, item_id),
    UNIQUE (order_id, tag_id)
);
CREATE INDEX picking_scans_line_idx ON public.picking_scans (order_id, product_id);
CREATE UNIQUE INDEX picking_scans_active_item_idx ON public.picking_scans (item_id) WHERE released_at IS NULL;
CREATE UNIQUE INDEX picking_scans_active_tag_idx ON public.picking_scans (tag_id) WHERE released_at IS NULL;

ALTER TABLE public.picking_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.picking_order_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.picking_scans ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.picking_orders, public.picking_order_lines, public.picking_scans FROM PUBLIC;
DO $acl$
DECLARE client_role TEXT;
BEGIN
    FOREACH client_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = client_role) THEN
            EXECUTE format('REVOKE ALL ON public.picking_orders, public.picking_order_lines, public.picking_scans FROM %I', client_role);
        END IF;
    END LOOP;
END
$acl$;
COMMIT;
