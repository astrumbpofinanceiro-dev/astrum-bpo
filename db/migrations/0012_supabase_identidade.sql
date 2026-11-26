-- 0012 — Endurecimento para Supabase e requisitos da Etapa 2

-- 1. A aplicação não usa a Data API. Os papéis dela não recebem nada em public.
DO $$ DECLARE r text; BEGIN
  FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM %I', r);
    END IF;
  END LOOP;
END $$;

-- 2. RLS em users. is_bpo_master passa a SECURITY DEFINER para não recorrer na própria política
--    (sem FORCE: o dono do schema lê users; a aplicação continua sujeita à política).
CREATE OR REPLACE FUNCTION app.is_bpo_master() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS
$$ SELECT COALESCE(app.setting('app.is_bpo_master') = 'true', false)
      AND EXISTS (SELECT 1 FROM public.users u
                  WHERE u.id = app.current_user_id() AND u.is_bpo_master AND u.is_active) $$;

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
CREATE POLICY users_read ON users FOR SELECT USING (
  id = app.current_user_id() OR app.is_bpo_master()
  OR EXISTS (SELECT 1 FROM tenant_memberships m WHERE m.user_id = users.id AND m.tenant_id = app.current_tenant_id())
  OR EXISTS (SELECT 1 FROM bpo_staff_assignments a WHERE a.user_id = users.id AND a.tenant_id = app.current_tenant_id()));
CREATE POLICY users_insert ON users FOR INSERT WITH CHECK (
  app.is_bpo_master()
  OR EXISTS (SELECT 1 FROM tenant_memberships m WHERE m.user_id = app.current_user_id()
             AND m.tenant_id = app.current_tenant_id() AND m.client_role = 'CLIENT_MASTER' AND m.is_active));
CREATE POLICY users_update ON users FOR UPDATE
  USING (app.is_bpo_master()) WITH CHECK (app.is_bpo_master());

-- Existência de e-mail (sem revelar de quem), para nunca reconvidar uma conta já usada.
CREATE FUNCTION app.email_registered(p_email text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS
$$ SELECT app.current_user_id() IS NOT NULL
      AND EXISTS (SELECT 1 FROM public.users WHERE lower(email) = lower(p_email)) $$;
REVOKE ALL ON FUNCTION app.email_registered(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.email_registered(text) TO bpo_app;

-- 3. user_scopes é configuração de acesso (não é registro financeiro): pode ser substituída.
--    O valor removido fica em audit_logs.
DROP TRIGGER no_delete ON user_scopes;
GRANT DELETE ON user_scopes TO bpo_app;
CREATE FUNCTION app.trg_audit_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF app.current_user_id() IS NULL OR app.setting('app.actor_role') IS NULL THEN
    RAISE EXCEPTION 'AUDIT_CONTEXT_REQUIRED';
  END IF;
  INSERT INTO audit_logs (tenant_id, actor_user_id, actor_effective_role, entity_type, entity_id, action, old_values, reason)
  VALUES (OLD.tenant_id, app.current_user_id(), app.setting('app.actor_role'), TG_TABLE_NAME, OLD.id,
          'DELETE', to_jsonb(OLD), app.setting('app.change_reason'));
  RETURN NULL;
END $$;
CREATE TRIGGER audit_delete AFTER DELETE ON user_scopes FOR EACH ROW EXECUTE FUNCTION app.trg_audit_delete();

-- 4. Usuário técnico dos jobs (SYSTEM_WORKER). Inativo: não consegue autenticar.
SELECT set_config('app.current_user_id', '00000000-0000-4000-8000-000000000001', true),
       set_config('app.actor_role', 'SYSTEM_WORKER', true);
INSERT INTO users (id, email, full_name, is_active)
VALUES ('00000000-0000-4000-8000-000000000001', 'system@internal.invalid', 'Processos automáticos', false);
SELECT set_config('app.current_user_id', '', true), set_config('app.actor_role', '', true);
