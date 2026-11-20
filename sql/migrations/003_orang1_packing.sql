-- Additive packing workflow. Apply only to an approved database.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE public.picking_packing (
    order_id UUID PRIMARY KEY REFERENCES public.picking_orders(id),
    quantity_checked BOOLEAN NOT NULL DEFAULT false,
    epc_checked BOOLEAN NOT NULL DEFAULT false,
    condition_checked BOOLEAN NOT NULL DEFAULT false,
    packaging_checked BOOLEAN NOT NULL DEFAULT false,
    label_checked BOOLEAN NOT NULL DEFAULT false,
    status TEXT NOT NULL DEFAULT 'MENUNGGU_PACKING' CHECK (status IN ('MENUNGGU_PACKING', 'SELESAI_PACKING')),
    revision INTEGER NOT NULL CHECK (revision > 0),
    checked_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    completed_at TIMESTAMPTZ,
    CHECK (
      (status = 'MENUNGGU_PACKING' AND completed_at IS NULL AND completed_by IS NULL)
      OR (status = 'SELESAI_PACKING' AND completed_at IS NOT NULL
          AND quantity_checked AND epc_checked AND condition_checked AND packaging_checked AND label_checked)
    )
);

-- Keep the actor UUID and name as audit snapshots even if the account is deleted.
CREATE TABLE public.picking_packing_events (
    order_id UUID NOT NULL REFERENCES public.picking_packing(order_id),
    revision INTEGER NOT NULL CHECK (revision > 0),
    action TEXT NOT NULL CHECK (action IN ('CHECKLIST_SAVED', 'PACKING_COMPLETED')),
    actor_id UUID NOT NULL,
    actor_name TEXT,
    checklist JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (order_id, revision)
);
CREATE UNIQUE INDEX picking_packing_single_completion
    ON public.picking_packing_events (order_id) WHERE action = 'PACKING_COMPLETED';

ALTER TABLE public.picking_packing ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.picking_packing_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.picking_packing, public.picking_packing_events FROM PUBLIC;
DO $acl$
DECLARE client_role TEXT;
BEGIN
    FOREACH client_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = client_role) THEN
            EXECUTE format('REVOKE ALL ON public.picking_packing, public.picking_packing_events FROM %I', client_role);
        END IF;
    END LOOP;
END
$acl$;
COMMIT;
