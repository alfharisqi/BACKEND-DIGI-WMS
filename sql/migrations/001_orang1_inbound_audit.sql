-- MANUAL ONLY: review/approval required before running the WHOLE file in Supabase SQL Editor.
-- Backend role verified on 2026-11-09: current_user = postgres, BYPASSRLS = true.
-- Creates only this audit table, its owned BIGINT sequence, PK index and entity index.
-- RLS/ACL changes below apply only to these NEW audit objects. No business data/roles/default grants change.
-- Intentionally no IF NOT EXISTS: an existing object must trigger a separate review, not be silently reused.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = pg_catalog, public;

DO $preflight$
DECLARE
    client_role TEXT;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_roles
        WHERE rolname = 'postgres' AND (rolbypassrls OR rolsuper)
    ) THEN
        RAISE EXCEPTION 'Verified backend role postgres is absent or no longer BYPASSRLS/superuser. Review backend access before applying.';
    END IF;
    IF NOT has_schema_privilege('postgres', 'public', 'USAGE') THEN
        RAISE EXCEPTION 'Backend role postgres requires existing USAGE on schema public. No schema privileges were changed.';
    END IF;
    FOREACH client_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = client_role) THEN
            RAISE EXCEPTION 'Expected Supabase role % is absent; use a Supabase-compatible test environment.', client_role;
        END IF;
        IF pg_has_role(client_role, 'postgres', 'MEMBER') THEN
            RAISE EXCEPTION 'Role % can assume backend role postgres. Review role membership separately.', client_role;
        END IF;
    END LOOP;
END
$preflight$;

-- Explicit sequence name avoids BIGSERIAL silently choosing a different name after a collision.
-- This is BIGSERIAL-equivalent, with the same bigint ID/default/ownership and no existing PK changes.
CREATE SEQUENCE public.orang1_inbound_audit_id_seq AS BIGINT;
CREATE TABLE public.orang1_inbound_audit (
    id BIGINT PRIMARY KEY DEFAULT nextval('public.orang1_inbound_audit_id_seq'::regclass),
    entity_type TEXT NOT NULL CHECK (entity_type IN ('product', 'grn', 'tag')),
    entity_id TEXT NOT NULL,
    action TEXT NOT NULL,
    before_data JSONB,
    after_data JSONB NOT NULL,
    reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER SEQUENCE public.orang1_inbound_audit_id_seq
    OWNED BY public.orang1_inbound_audit.id;
CREATE INDEX orang1_inbound_audit_entity_idx
    ON public.orang1_inbound_audit (entity_type, entity_id, id);

ALTER TABLE public.orang1_inbound_audit ENABLE ROW LEVEL SECURITY;
-- No policies: default deny for ordinary roles. postgres is the verified trusted backend (BYPASSRLS).
-- RLS does not protect sequences or TRUNCATE; revoke object privileges too, including inherited PUBLIC.
REVOKE ALL PRIVILEGES ON TABLE public.orang1_inbound_audit
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL PRIVILEGES ON SEQUENCE public.orang1_inbound_audit_id_seq
    FROM PUBLIC, anon, authenticated, service_role;

-- pg uses the database login role, NOT a Supabase API key. Its audit queries need SELECT/INSERT/nextval.
GRANT SELECT, INSERT ON TABLE public.orang1_inbound_audit TO postgres;
GRANT USAGE ON SEQUENCE public.orang1_inbound_audit_id_seq TO postgres;

DO $verify_access$
DECLARE
    client_role TEXT;
    privilege_name TEXT;
    table_privileges TEXT[] := ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
BEGIN
    IF current_setting('server_version_num')::INTEGER >= 170000 THEN
        table_privileges := array_append(table_privileges, 'MAINTAIN');
    END IF;
    FOREACH client_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
        FOREACH privilege_name IN ARRAY table_privileges LOOP
            IF has_table_privilege(client_role, 'public.orang1_inbound_audit', privilege_name) THEN
                RAISE EXCEPTION 'Role % still inherits % on audit; transaction rolled back. Review inherited grants separately.', client_role, privilege_name;
            END IF;
        END LOOP;
        IF has_any_column_privilege(client_role, 'public.orang1_inbound_audit', 'SELECT,INSERT,UPDATE,REFERENCES')
           OR has_sequence_privilege(client_role, 'public.orang1_inbound_audit_id_seq', 'USAGE,SELECT,UPDATE') THEN
            RAISE EXCEPTION 'Role % still has column/sequence access; transaction rolled back.', client_role;
        END IF;
    END LOOP;
    IF NOT has_table_privilege('postgres', 'public.orang1_inbound_audit', 'SELECT')
       OR NOT has_table_privilege('postgres', 'public.orang1_inbound_audit', 'INSERT')
       OR NOT has_sequence_privilege('postgres', 'public.orang1_inbound_audit_id_seq', 'USAGE') THEN
        RAISE EXCEPTION 'Backend audit permissions are incomplete; transaction rolled back.';
    END IF;
END
$verify_access$;

COMMIT;
