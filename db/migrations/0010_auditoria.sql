-- 0010 — Trilha de auditoria automática (Doc 1 §0, Doc 2 §6.3 e §7)
-- Escrita sem contexto de ator é recusada: não existe alteração anônima.

CREATE FUNCTION app.trg_audit_stamp() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.created_at := now();
  -- Calculado no banco: o chamador não consegue omitir a marca de acesso privilegiado.
  NEW.is_bpo_master_impersonation :=
    app.is_bpo_master() AND NEW.tenant_id IS NOT NULL AND NEW.tenant_id IS NOT DISTINCT FROM app.current_tenant_id();
  IF NEW.is_bpo_master_impersonation THEN
    NEW.impersonation_reason := COALESCE(NEW.impersonation_reason, app.setting('app.impersonation_reason'));
    IF NEW.impersonation_reason IS NULL THEN
      RAISE EXCEPTION 'IMPERSONATION_REASON_REQUIRED' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  NEW.source := COALESCE(NEW.source, app.setting('app.source'));
  NEW.correlation_id := COALESCE(NEW.correlation_id, app.setting('app.correlation_id')::uuid);
  RETURN NEW;
END $$;
CREATE TRIGGER audit_stamp BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION app.trg_audit_stamp();

CREATE FUNCTION app.trg_audit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_new jsonb := to_jsonb(NEW); v_old jsonb;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    v_old := to_jsonb(OLD);
    IF v_old = v_new THEN RETURN NULL; END IF;
  END IF;
  IF app.current_user_id() IS NULL OR app.setting('app.actor_role') IS NULL THEN
    RAISE EXCEPTION 'AUDIT_CONTEXT_REQUIRED: defina app.current_user_id e app.actor_role';
  END IF;
  INSERT INTO audit_logs (tenant_id, actor_user_id, actor_effective_role, entity_type, entity_id,
                          action, old_values, new_values, reason)
  VALUES (CASE TG_TABLE_NAME WHEN 'tenants' THEN (v_new->>'id')::uuid ELSE (v_new->>'tenant_id')::uuid END,
          app.current_user_id(), app.setting('app.actor_role'), TG_TABLE_NAME, (v_new->>'id')::uuid,
          TG_OP, v_old, v_new, app.setting('app.change_reason'));
  RETURN NULL;
END $$;

DO $$ DECLARE t text; BEGIN
  FOR t IN SELECT tablename FROM pg_tables
            WHERE schemaname = 'public' AND tablename NOT IN ('audit_logs','batch_items') LOOP
    EXECUTE format('CREATE TRIGGER audit AFTER INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION app.trg_audit()', t);
  END LOOP;
END $$;
-- batch_items: a inserção é coberta pelo lote (raw_payload preservado); audita-se cada decisão posterior.
CREATE TRIGGER audit AFTER UPDATE ON batch_items FOR EACH ROW EXECUTE FUNCTION app.trg_audit();
