-- Archived proposal. Do not apply.
-- This proposal requires a compatible backend with dedicated transaction markers.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

LOCK TABLE public.picking_scans IN SHARE MODE NOWAIT;
LOCK TABLE public.tags, public.items, public.gate_passes IN SHARE ROW EXCLUSIVE MODE NOWAIT;

CREATE INDEX picking_scans_released_tag_idx ON public.picking_scans (tag_id, order_id)
    WHERE released_at IS NOT NULL;

CREATE FUNCTION public.require_validated_released_epc() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $fn$
DECLARE
    checked_tag UUID;
    allowed_tags JSONB;
BEGIN
    IF TG_TABLE_NAME = 'tags' THEN
        checked_tag := NEW.id;
    ELSE
        checked_tag := NEW.tag_id;
    END IF;

    IF checked_tag IS NULL THEN
        RETURN NEW;
    END IF;

    allowed_tags := COALESCE(NULLIF(current_setting(
        CASE WHEN NEW.status = 'AUTHORIZED_OUT' THEN 'digiwms.validated_outbound_authorize_tag_ids'
            ELSE 'digiwms.validated_outbound_exit_tag_ids' END, true), ''), '[]')::jsonb;
    IF NOT (allowed_tags ? checked_tag::text) AND EXISTS (
        SELECT 1 FROM public.picking_scans ps
        JOIN public.picking_cancellations pc ON pc.order_id = ps.order_id
        WHERE ps.tag_id = checked_tag AND ps.released_at IS NOT NULL
    ) THEN
        RAISE EXCEPTION 'EPC dari pembatalan Picking memerlukan otorisasi Pengiriman atau Gate Pass yang tervalidasi.'
            USING ERRCODE = '23514', CONSTRAINT = 'picking_released_epc_outbound_guard';
    END IF;
    RETURN NEW;
END
$fn$;

CREATE TRIGGER picking_released_epc_guard_tags
BEFORE UPDATE OF status ON public.tags
FOR EACH ROW WHEN (NEW.status IN ('AUTHORIZED_OUT', 'EXITED'))
EXECUTE FUNCTION public.require_validated_released_epc();

CREATE TRIGGER picking_released_epc_guard_items
BEFORE UPDATE OF status ON public.items
FOR EACH ROW WHEN (NEW.status IN ('AUTHORIZED_OUT', 'EXITED'))
EXECUTE FUNCTION public.require_validated_released_epc();

CREATE FUNCTION public.reject_cancelled_picking_gate_reference() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $fn$
DECLARE
    referenced_order RECORD;
BEGIN
    FOR referenced_order IN
        SELECT status FROM public.picking_orders
        WHERE order_number = NEW.reference_resi OR
            (left(NEW.reference_resi, 5) = 'RESI-' AND order_number = substr(NEW.reference_resi, 6))
        ORDER BY id FOR SHARE
    LOOP
        IF referenced_order.status = 'DIBATALKAN' THEN
            RAISE EXCEPTION 'Gate Pass tidak dapat merujuk pada pesanan Picking yang dibatalkan.'
                USING ERRCODE = '23514', CONSTRAINT = 'picking_cancelled_gate_reference_guard';
        END IF;
    END LOOP;
    RETURN NEW;
END
$fn$;

CREATE TRIGGER picking_cancelled_gate_reference_guard
BEFORE INSERT OR UPDATE OF reference_resi ON public.gate_passes
FOR EACH ROW EXECUTE FUNCTION public.reject_cancelled_picking_gate_reference();

COMMIT;
