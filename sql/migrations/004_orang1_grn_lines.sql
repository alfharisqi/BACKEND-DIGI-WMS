BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.goods_receipts ADD COLUMN has_sku_lines boolean NOT NULL DEFAULT false;
ALTER TABLE public.orang1_inbound_audit ADD COLUMN actor_id uuid REFERENCES public.users(id) ON DELETE SET NULL;

CREATE TABLE public.goods_receipt_lines (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    grn_id uuid NOT NULL REFERENCES public.goods_receipts(id),
    product_id uuid NOT NULL REFERENCES public.products(id),
    received_qty integer NOT NULL CHECK (received_qty > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (grn_id, product_id),
    UNIQUE (id, grn_id, product_id)
);
ALTER TABLE public.items ADD COLUMN grn_line_id uuid,
    ADD COLUMN inbound_purpose text CHECK (inbound_purpose IN ('RECEIPT','ASSET','SPECIAL')),
    ADD CHECK (grn_line_id IS NULL OR grn_id IS NOT NULL),
    ADD CHECK (inbound_purpose IS NULL OR
        (inbound_purpose = 'RECEIPT' AND grn_line_id IS NOT NULL) OR
        (inbound_purpose IN ('ASSET','SPECIAL') AND grn_id IS NULL AND grn_line_id IS NULL)),
    ADD FOREIGN KEY (grn_line_id, grn_id, product_id)
        REFERENCES public.goods_receipt_lines(id, grn_id, product_id);
CREATE INDEX items_grn_line_idx ON public.items(grn_line_id) WHERE grn_line_id IS NOT NULL;

CREATE FUNCTION public.check_inbound_grn_total() RETURNS trigger LANGUAGE plpgsql
SET search_path = public, pg_catalog AS $$
DECLARE receipt uuid;
BEGIN
    IF TG_TABLE_NAME = 'goods_receipts' THEN
        receipt := NEW.id;
    ELSIF TG_OP = 'DELETE' THEN
        receipt := OLD.grn_id;
    ELSE
        receipt := NEW.grn_id;
        IF TG_OP = 'UPDATE' AND OLD.grn_id <> NEW.grn_id THEN
            RAISE EXCEPTION 'Baris GRN tidak dapat dipindahkan ke header lain' USING ERRCODE = '23514';
        END IF;
    END IF;
    IF EXISTS (
        SELECT 1 FROM public.goods_receipts g WHERE g.id = receipt
        AND (CASE WHEN g.has_sku_lines THEN g.total_qty ELSE 0 END) <>
            (SELECT coalesce(sum(l.received_qty), 0) FROM public.goods_receipt_lines l WHERE l.grn_id = g.id)
    ) THEN
        RAISE EXCEPTION 'Total GRN tidak sesuai dengan rincian SKU' USING ERRCODE = '23514';
    END IF;
    RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER grn_header_total AFTER INSERT OR UPDATE ON public.goods_receipts
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_inbound_grn_total();
CREATE CONSTRAINT TRIGGER grn_line_total AFTER INSERT OR UPDATE OR DELETE ON public.goods_receipt_lines
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_inbound_grn_total();

-- Only extend the two verified UUID fixture checks. Refuse an unreviewed schema.
DO $$
DECLARE tag_check text; grn_check text;
BEGIN
    SELECT pg_get_expr(conbin, conrelid) INTO STRICT tag_check FROM pg_constraint
        WHERE conrelid = 'public.tags'::regclass AND conname = 'qa_tag_status' AND contype = 'c';
    SELECT pg_get_expr(conbin, conrelid) INTO STRICT grn_check FROM pg_constraint
        WHERE conrelid = 'public.goods_receipts'::regclass AND conname = 'qa_grn_status' AND contype = 'c';
    IF tag_check <> $rule$(status = ANY (ARRAY['UNASSIGNED'::text, 'ENCODED'::text, 'IN_STOCK'::text, 'RESERVED'::text, 'AUTHORIZED_OUT'::text, 'EXITED'::text]))$rule$
        OR grn_check <> $rule$(status = ANY (ARRAY['MENUNGGU_VERIFIKASI'::text, 'SELESAI'::text]))$rule$ THEN
        RAISE EXCEPTION 'Periksa constraint status UUID sebelum migrasi Inbound';
    END IF;
    ALTER TABLE public.tags DROP CONSTRAINT qa_tag_status,
        ADD CONSTRAINT qa_tag_status CHECK (status IN ('UNASSIGNED','ENCODED','IN_STOCK','RESERVED','AUTHORIZED_OUT','EXITED','DAMAGED'));
    ALTER TABLE public.goods_receipts DROP CONSTRAINT qa_grn_status,
        ADD CONSTRAINT qa_grn_status CHECK (status IN ('MENUNGGU_VERIFIKASI','SELESAI','DIBATALKAN'));
END $$;

ALTER TABLE public.goods_receipt_lines ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.goods_receipt_lines FROM PUBLIC;
DO $$
DECLARE client_role text;
BEGIN
    FOREACH client_role IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
        IF EXISTS (SELECT FROM pg_roles WHERE rolname = client_role) THEN
            EXECUTE format('REVOKE ALL ON public.goods_receipt_lines FROM %I', client_role);
        END IF;
    END LOOP;
END $$;
COMMIT;
