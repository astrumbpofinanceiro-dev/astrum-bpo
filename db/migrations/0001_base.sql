-- 0001 — Schema auxiliar, role de aplicação e contexto de sessão (Doc 2 §0 e §7)
CREATE SCHEMA app;

-- Role de grupo usada pelo servidor. Sem SUPERUSER e sem BYPASSRLS.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bpo_app') THEN
    CREATE ROLE bpo_app NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;

-- Variáveis definidas por transação pelo backend, após validar a sessão.
-- Ausente ou vazia => NULL => nenhuma linha visível (fail-closed).
CREATE FUNCTION app.current_user_id() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT NULLIF(current_setting('app.current_user_id', true), '')::uuid $$;

CREATE FUNCTION app.current_tenant_id() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT NULLIF(current_setting('app.current_tenant_id', true), '')::uuid $$;

CREATE FUNCTION app.setting(p_name text) RETURNS text LANGUAGE sql STABLE AS
$$ SELECT NULLIF(current_setting(p_name, true), '') $$;
