-- 0011 — Isolamento multi-tenant (RLS) e privilégios mínimos (Doc 2 §7)

-- Política padrão em toda tabela com tenant_id. Não há bypass para BPO Master:
-- ele também precisa selecionar o tenant.
DO $$ DECLARE t text; BEGIN
  FOR t IN SELECT c.table_name FROM information_schema.columns c
             JOIN pg_tables p ON p.schemaname = c.table_schema AND p.tablename = c.table_name
            WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id' AND c.table_name <> 'audit_logs' LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app.current_tenant_id()) '
                   'WITH CHECK (tenant_id = app.current_tenant_id())', t);
  END LOOP;
END $$;

-- Descoberta de acesso antes de escolher o tenant: cada usuário lê os próprios vínculos.
-- ATENÇÃO: consultas dessas duas tabelas no backend devem sempre filtrar tenant_id.
CREATE POLICY own_membership ON tenant_memberships FOR SELECT USING (user_id = app.current_user_id());
CREATE POLICY own_assignment ON bpo_staff_assignments FOR SELECT USING (user_id = app.current_user_id());

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON tenants FOR SELECT USING (
  id = app.current_tenant_id() OR app.is_bpo_master()
  OR EXISTS (SELECT 1 FROM tenant_memberships m WHERE m.tenant_id = tenants.id
              AND m.user_id = app.current_user_id() AND m.is_active)
  OR EXISTS (SELECT 1 FROM bpo_staff_assignments a WHERE a.tenant_id = tenants.id
              AND a.user_id = app.current_user_id() AND a.revoked_at IS NULL));
CREATE POLICY tenant_insert ON tenants FOR INSERT WITH CHECK (app.is_bpo_master());
CREATE POLICY tenant_update ON tenants FOR UPDATE USING (app.is_bpo_master()) WITH CHECK (app.is_bpo_master());

ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_read ON audit_logs FOR SELECT USING (
  tenant_id = app.current_tenant_id() OR (tenant_id IS NULL AND app.is_bpo_master()));
CREATE POLICY audit_write ON audit_logs FOR INSERT WITH CHECK (
  actor_user_id = app.current_user_id()
  AND (tenant_id IS NULL OR tenant_id = app.current_tenant_id() OR app.is_bpo_master()));

-- Privilégios: nenhum DELETE/TRUNCATE para a aplicação.
GRANT USAGE ON SCHEMA public, app TO bpo_app;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO bpo_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO bpo_app;
REVOKE UPDATE ON audit_logs, document_files, reconciliation_allocations, closing_version_issues FROM bpo_app;
-- A aplicação não promove ninguém a Master (somente migration/script administrativo).
REVOKE INSERT, UPDATE ON users FROM bpo_app;
GRANT INSERT (id, email, full_name, is_active), UPDATE (email, full_name, is_active) ON users TO bpo_app;
