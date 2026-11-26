-- Apply only during the coordinated change window with older write paths paused.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- Abort immediately if an active session holds a conflicting order lock.
LOCK TABLE public.picking_orders IN ACCESS EXCLUSIVE MODE NOWAIT;
LOCK TABLE public.picking_scans, public.tags IN SHARE ROW EXCLUSIVE MODE NOWAIT;

ALTER TABLE public.picking_orders
    DROP CONSTRAINT picking_orders_status_check,
    ADD CONSTRAINT picking_orders_status_check
        CHECK (status IN ('MENUNGGU_PICKING', 'SEDANG_DIAMBIL', 'SIAP_PACKING', 'DIBATALKAN'));

-- One immutable event per order by application contract. Actor name and UUID
-- are snapshots retained when an account changes or is removed.
CREATE TABLE public.picking_cancellations (
    order_id UUID PRIMARY KEY REFERENCES public.picking_orders(id),
    order_number TEXT NOT NULL,
    previous_status TEXT NOT NULL CHECK (previous_status IN ('MENUNGGU_PICKING', 'SEDANG_DIAMBIL')),
    reason TEXT NOT NULL CHECK (reason IN (
        'STOK_TIDAK_MENCUKUPI', 'BARANG_TIDAK_TERSEDIA', 'PESANAN_PELANGGAN_DIBATALKAN',
        'KESALAHAN_PEMBUATAN_PESANAN', 'KESALAHAN_PEMILIHAN_SKU', 'LAINNYA'
    )),
    notes TEXT,
    actor_id UUID NOT NULL,
    actor_name TEXT,
    cancelled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    physical_return_confirmed BOOLEAN NOT NULL DEFAULT false,
    released_units JSONB NOT NULL DEFAULT '[]'::jsonb,
    CHECK (reason <> 'LAINNYA' OR nullif(btrim(notes), '') IS NOT NULL),
    CHECK (CASE WHEN jsonb_typeof(released_units) = 'array' THEN
        CASE previous_status WHEN 'SEDANG_DIAMBIL'
            THEN physical_return_confirmed AND jsonb_array_length(released_units) > 0
            ELSE NOT physical_return_confirmed AND jsonb_array_length(released_units) = 0
        END
        ELSE false END)
);

ALTER TABLE public.picking_cancellations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.picking_cancellations FROM PUBLIC;
DO $acl$
DECLARE client_role TEXT;
BEGIN
    FOREACH client_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = client_role) THEN
            EXECUTE format('REVOKE ALL ON public.picking_cancellations FROM %I', client_role);
        END IF;
    END LOOP;
END
$acl$;

-- Legacy scan handlers may treat a recently cancelled order as still open.
CREATE FUNCTION public.keep_picking_cancellation_terminal() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $fn$
BEGIN
    IF OLD.status = 'DIBATALKAN' AND NEW.status IS DISTINCT FROM OLD.status THEN
        RAISE EXCEPTION 'Pesanan Picking sudah dibatalkan.' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END
$fn$;
CREATE TRIGGER picking_cancellation_terminal
BEFORE UPDATE OF status ON public.picking_orders
FOR EACH ROW EXECUTE FUNCTION public.keep_picking_cancellation_terminal();

CREATE FUNCTION public.reject_scan_on_cancelled_picking() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $fn$
DECLARE order_status TEXT;
BEGIN
    SELECT status INTO order_status FROM public.picking_orders WHERE id = NEW.order_id FOR UPDATE;
    IF order_status = 'DIBATALKAN' THEN
        RAISE EXCEPTION 'Pesanan Picking sudah dibatalkan.' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END
$fn$;
CREATE TRIGGER picking_cancellation_reject_scan
BEFORE INSERT OR UPDATE OF order_id ON public.picking_scans
FOR EACH ROW EXECUTE FUNCTION public.reject_scan_on_cancelled_picking();

-- Guard the legacy Gate Pass path that wrote tag status without a source.
CREATE FUNCTION public.reject_early_picking_gate_authorization() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $fn$
BEGIN
    IF OLD.status = 'RESERVED' AND NEW.status = 'AUTHORIZED_OUT' AND EXISTS (
        SELECT 1 FROM public.picking_scans s
        JOIN public.picking_orders o ON o.id = s.order_id
        LEFT JOIN public.picking_packing p ON p.order_id = o.id
        WHERE s.tag_id = OLD.id AND s.released_at IS NULL
            AND (o.status <> 'SIAP_PACKING' OR p.status IS DISTINCT FROM 'SELESAI_PACKING')
    ) THEN
        RAISE EXCEPTION 'EPC Picking memerlukan Packing yang telah difinalisasi.' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END
$fn$;
CREATE TRIGGER picking_cancellation_protect_reserved_tag
BEFORE UPDATE OF status ON public.tags
FOR EACH ROW EXECUTE FUNCTION public.reject_early_picking_gate_authorization();
COMMIT;
