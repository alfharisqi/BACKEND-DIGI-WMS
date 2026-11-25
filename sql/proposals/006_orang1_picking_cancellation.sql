-- Draft for review by the team. Apply only after approval and the downstream
-- handoff changes documented in ORANG1_MVP2_PICKING_ENHANCEMENT_REPORT.md.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

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
    CHECK (CASE WHEN jsonb_typeof(released_units) = 'array'
        THEN jsonb_array_length(released_units) = 0 OR physical_return_confirmed
        ELSE false END)
);

ALTER TABLE public.picking_cancellations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.picking_cancellations FROM PUBLIC, anon, authenticated, service_role;
COMMIT;
