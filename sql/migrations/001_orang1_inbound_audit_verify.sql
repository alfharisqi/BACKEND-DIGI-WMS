-- READ ONLY. Safe before/after the manual migration; never reads audit payloads or business rows.
-- Run the whole file. From the backend connection, current_user must be postgres.
-- SQL Editor reports its own session identity, not the identity of a different backend connection.
BEGIN READ ONLY;

SELECT current_user AS execution_role, session_user AS login_role,
       current_setting('transaction_read_only') AS read_only,
       current_setting('server_version') AS server_version;

SELECT rolname, rolsuper, rolbypassrls,
       has_schema_privilege(oid, 'public', 'USAGE') AS public_usage
FROM pg_roles
WHERE rolname IN ('postgres', 'anon', 'authenticated', 'service_role')
ORDER BY rolname;

SELECT to_regclass('public.orang1_inbound_audit') AS audit_table,
       to_regclass('public.orang1_inbound_audit_id_seq') AS audit_sequence;

SELECT c.relname, c.relkind, pg_get_userbyid(c.relowner) AS owner,
       c.relrowsecurity AS rls_enabled, c.relforcerowsecurity AS rls_forced,
       c.relacl AS object_acl
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orang1_inbound_audit', 'orang1_inbound_audit_id_seq')
ORDER BY c.relname;

SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'orang1_inbound_audit'
ORDER BY ordinal_position;

SELECT i.relname AS index_name, ix.indisprimary, ix.indisvalid, ix.indisready,
       pg_get_indexdef(i.oid) AS definition
FROM pg_index ix JOIN pg_class i ON i.oid = ix.indexrelid
WHERE ix.indrelid = to_regclass('public.orang1_inbound_audit')
ORDER BY i.relname;

SELECT conname, contype, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid = to_regclass('public.orang1_inbound_audit')
ORDER BY conname;

-- Expected: zero rows (no client policies; backend postgres has BYPASSRLS).
SELECT schemaname, tablename, policyname, roles, cmd, qual, with_check
FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'orang1_inbound_audit';

-- Expected: postgres can_select/can_insert/sequence_usage = true; all client privileges = false.
-- postgres remains an administrative/owner role, so UPDATE/DELETE/etc may also be true for it.
-- These are effective grants (including inherited grants), not policy evaluation.
SELECT r.rolname,
       has_table_privilege(r.oid, to_regclass('public.orang1_inbound_audit'), 'SELECT') AS can_select,
       has_table_privilege(r.oid, to_regclass('public.orang1_inbound_audit'), 'INSERT') AS can_insert,
       has_table_privilege(r.oid, to_regclass('public.orang1_inbound_audit'), 'UPDATE') AS can_update,
       has_table_privilege(r.oid, to_regclass('public.orang1_inbound_audit'), 'DELETE') AS can_delete,
       has_table_privilege(r.oid, to_regclass('public.orang1_inbound_audit'), 'TRUNCATE') AS can_truncate,
       has_table_privilege(r.oid, to_regclass('public.orang1_inbound_audit'), 'REFERENCES') AS can_reference,
       has_table_privilege(r.oid, to_regclass('public.orang1_inbound_audit'), 'TRIGGER') AS can_trigger,
       CASE WHEN current_setting('server_version_num')::INTEGER >= 170000
            THEN has_table_privilege(r.oid, to_regclass('public.orang1_inbound_audit'), 'MAINTAIN') END AS can_maintain_pg17,
       has_any_column_privilege(r.oid, to_regclass('public.orang1_inbound_audit'), 'SELECT,INSERT,UPDATE,REFERENCES') AS any_column_access,
       has_sequence_privilege(r.oid, to_regclass('public.orang1_inbound_audit_id_seq'), 'USAGE') AS sequence_usage,
       has_sequence_privilege(r.oid, to_regclass('public.orang1_inbound_audit_id_seq'), 'SELECT') AS sequence_select,
       has_sequence_privilege(r.oid, to_regclass('public.orang1_inbound_audit_id_seq'), 'UPDATE') AS sequence_update
FROM pg_roles r
WHERE r.rolname IN ('postgres', 'anon', 'authenticated', 'service_role')
ORDER BY r.rolname;

-- Expected false for every client. Future membership changes need a new review.
SELECT rolname, pg_has_role(rolname, 'postgres', 'MEMBER') AS can_assume_backend_role
FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role')
ORDER BY rolname;

-- BIGSERIAL-equivalent sequence must be owned by audit.id; read-only lookup (no nextval/setval).
SELECT CASE WHEN to_regclass('public.orang1_inbound_audit') IS NOT NULL
            THEN pg_get_serial_sequence('public.orang1_inbound_audit', 'id') END AS owned_sequence;

ROLLBACK;
