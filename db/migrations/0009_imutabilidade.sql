-- 0009 — Imutabilidade: originais, versões publicadas e competências fechadas

CREATE FUNCTION app.trg_forbid() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'IMMUTABLE_RECORD: % não permite %', TG_TABLE_NAME, TG_OP;
END $$;

-- Exclusão física proibida em todas as tabelas de negócio (Doc 2 §0).
DO $$ DECLARE t text; BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('CREATE TRIGGER no_delete BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION app.trg_forbid()', t);
    EXECUTE format('CREATE TRIGGER no_truncate BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION app.trg_forbid()', t);
  END LOOP;
END $$;

-- Registros somente-inserção.
CREATE TRIGGER no_update BEFORE UPDATE ON audit_logs                 FOR EACH ROW EXECUTE FUNCTION app.trg_forbid();
CREATE TRIGGER no_update BEFORE UPDATE ON document_files             FOR EACH ROW EXECUTE FUNCTION app.trg_forbid();
CREATE TRIGGER no_update BEFORE UPDATE ON reconciliation_allocations FOR EACH ROW EXECUTE FUNCTION app.trg_forbid();
CREATE TRIGGER no_update BEFORE UPDATE ON closing_version_issues     FOR EACH ROW EXECUTE FUNCTION app.trg_forbid();

CREATE FUNCTION app.trg_original_date() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.original_expected_settlement_date IS DISTINCT FROM OLD.original_expected_settlement_date THEN
    RAISE EXCEPTION 'IMMUTABLE_FIELD: original_expected_settlement_date';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER original_date BEFORE UPDATE ON obligation_installments
  FOR EACH ROW EXECUTE FUNCTION app.trg_original_date();

-- ========== Versões de fechamento ==========
CREATE FUNCTION app.trg_closing_version_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - 'status') IS DISTINCT FROM (to_jsonb(OLD) - 'status')
     OR NOT (OLD.status = 'ACTIVE' AND NEW.status = 'SUPERSEDED') THEN
    RAISE EXCEPTION 'IMMUTABLE_RECORD: versão publicada só pode passar de ACTIVE para SUPERSEDED';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER closing_version_guard BEFORE UPDATE ON closing_versions
  FOR EACH ROW EXECUTE FUNCTION app.trg_closing_version_guard();

-- Pendência ressalvada precisa ser BLOCKING_OPERATIONAL.
CREATE FUNCTION app.trg_caveat_issue_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT severity FROM blocking_issues WHERE id = NEW.blocking_issue_id) IS DISTINCT FROM 'BLOCKING_OPERATIONAL' THEN
    RAISE EXCEPTION 'CAVEAT_ONLY_FOR_BLOCKING_OPERATIONAL' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER caveat_issue_check BEFORE INSERT ON closing_version_issues
  FOR EACH ROW EXECUTE FUNCTION app.trg_caveat_issue_check();

-- Verificada no COMMIT: fechamento com ressalva exige pendências vinculadas.
CREATE FUNCTION app.trg_caveat_requires_issues() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM closing_version_issues WHERE closing_version_id = NEW.id) THEN
    RAISE EXCEPTION 'CAVEAT_REQUIRES_LINKED_ISSUES' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER caveat_requires_issues AFTER INSERT ON closing_versions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (NEW.closing_type = 'PUBLISHED_WITH_CAVEATS') EXECUTE FUNCTION app.trg_caveat_requires_issues();

-- Competência publicada só sai por reabertura (Doc 1 §2.7).
CREATE FUNCTION app.trg_period_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.current_version_number < OLD.current_version_number
     OR NEW.competence_date <> OLD.competence_date OR NEW.tenant_id <> OLD.tenant_id THEN
    RAISE EXCEPTION 'IMMUTABLE_FIELD: period_closings';
  END IF;
  IF OLD.status IN ('CLOSED_PUBLISHED','CLOSED_WITH_CAVEATS') AND NEW.status NOT IN (OLD.status, 'REOPENED') THEN
    RAISE EXCEPTION 'PERIOD_CLOSED_REQUIRES_REOPEN' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER period_guard BEFORE UPDATE ON period_closings FOR EACH ROW EXECUTE FUNCTION app.trg_period_guard();

-- ========== Competência fechada (Doc 1 Exceção 7) ==========
-- FOR SHARE serializa com a transação que está publicando o fechamento.
CREATE FUNCTION app.assert_period_open(p_tenant uuid, p_date date) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_status text;
BEGIN
  IF p_date IS NULL THEN RETURN; END IF;
  SELECT status INTO v_status FROM period_closings
   WHERE tenant_id = p_tenant AND competence_date = date_trunc('month', p_date)::date FOR SHARE;
  IF v_status IN ('CLOSED_PUBLISHED','CLOSED_WITH_CAVEATS') THEN
    RAISE EXCEPTION 'PERIOD_CLOSED: competência % está %', to_char(p_date,'MM/YYYY'), v_status
      USING ERRCODE = 'check_violation';
  END IF;
END $$;

-- Argumentos: [0] como obter a data; demais = colunas que continuam livres após o fechamento.
CREATE FUNCTION app.trg_period_lock() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_rows jsonb[]; r jsonb; v_date date; v_free text[] := TG_ARGV[1:]; v_changed boolean := true;
BEGIN
  IF TG_OP = 'INSERT' THEN v_rows := ARRAY[to_jsonb(NEW)];
  ELSE
    v_changed := (to_jsonb(NEW) - v_free) IS DISTINCT FROM (to_jsonb(OLD) - v_free);
    v_rows := ARRAY[to_jsonb(OLD), to_jsonb(NEW)];
    -- Doc 1 §2.5: não se desfaz conciliação de período bloqueado.
    IF to_jsonb(OLD)->>'reconciliation_status' = 'RECONCILED'
       AND to_jsonb(NEW)->>'reconciliation_status' <> 'RECONCILED' THEN v_changed := true; END IF;
  END IF;
  IF NOT v_changed THEN RETURN NEW; END IF;

  FOREACH r IN ARRAY v_rows LOOP
    CASE TG_ARGV[0]
      WHEN 'installment' THEN
        SELECT o.competence_date INTO v_date FROM financial_obligations f
          JOIN economic_operations o ON o.id = f.economic_operation_id WHERE f.id = (r->>'obligation_id')::uuid;
      WHEN 'obligation' THEN
        SELECT competence_date INTO v_date FROM economic_operations WHERE id = (r->>'economic_operation_id')::uuid;
      WHEN 'settlement_child' THEN
        SELECT settlement_date INTO v_date FROM settlement_events WHERE id = (r->>'settlement_event_id')::uuid;
      WHEN 'anticipation_child' THEN
        SELECT effective_date INTO v_date FROM receivable_anticipations WHERE id = (r->>'anticipation_id')::uuid;
      ELSE
        v_date := (r->>TG_ARGV[0])::date;
    END CASE;
    PERFORM app.assert_period_open((r->>'tenant_id')::uuid, v_date);
  END LOOP;
  RETURN NEW;
END $$;

CREATE TRIGGER period_lock BEFORE INSERT OR UPDATE ON economic_operations
  FOR EACH ROW EXECUTE FUNCTION app.trg_period_lock('competence_date');
CREATE TRIGGER period_lock BEFORE INSERT OR UPDATE ON financial_obligations
  FOR EACH ROW EXECUTE FUNCTION app.trg_period_lock('obligation', 'status');
-- Liquidar em mês posterior continua permitido (Doc 3, Cenário 3).
CREATE TRIGGER period_lock BEFORE INSERT OR UPDATE ON obligation_installments
  FOR EACH ROW EXECUTE FUNCTION app.trg_period_lock('installment', 'status', 'settled_amount', 'current_expected_settlement_date');
CREATE TRIGGER period_lock BEFORE INSERT OR UPDATE ON bank_transactions
  FOR EACH ROW EXECUTE FUNCTION app.trg_period_lock('bank_posting_date', 'reconciliation_status');
CREATE TRIGGER period_lock BEFORE INSERT OR UPDATE ON cash_transactions
  FOR EACH ROW EXECUTE FUNCTION app.trg_period_lock('transaction_date', 'reconciliation_status');
CREATE TRIGGER period_lock BEFORE INSERT OR UPDATE ON internal_transfers
  FOR EACH ROW EXECUTE FUNCTION app.trg_period_lock('transfer_date', 'reconciliation_status');
CREATE TRIGGER period_lock BEFORE INSERT OR UPDATE ON settlement_events
  FOR EACH ROW EXECUTE FUNCTION app.trg_period_lock('settlement_date');
CREATE TRIGGER period_lock BEFORE INSERT OR UPDATE ON settlement_allocations
  FOR EACH ROW EXECUTE FUNCTION app.trg_period_lock('settlement_child');
CREATE TRIGGER period_lock BEFORE INSERT OR UPDATE ON settlement_fee_items
  FOR EACH ROW EXECUTE FUNCTION app.trg_period_lock('settlement_child');
CREATE TRIGGER period_lock BEFORE INSERT OR UPDATE ON receivable_anticipations
  FOR EACH ROW EXECUTE FUNCTION app.trg_period_lock('effective_date');
CREATE TRIGGER period_lock BEFORE INSERT OR UPDATE ON anticipation_allocations
  FOR EACH ROW EXECUTE FUNCTION app.trg_period_lock('anticipation_child');

-- Conciliar/desconciliar movimentação de competência fechada também é bloqueado.
CREATE FUNCTION app.assert_movement_open(p_tenant uuid, p_type text, p_id uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_date date;
BEGIN
  IF p_type = 'BANK_TRANSACTION' THEN SELECT bank_posting_date INTO v_date FROM bank_transactions WHERE id = p_id;
  ELSE SELECT transaction_date INTO v_date FROM cash_transactions WHERE id = p_id; END IF;
  PERFORM app.assert_period_open(p_tenant, v_date);
END $$;

CREATE FUNCTION app.trg_recon_alloc_period() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM app.assert_movement_open(NEW.tenant_id, NEW.left_entity_type, NEW.left_entity_id);
  RETURN NEW;
END $$;
CREATE TRIGGER recon_period_lock BEFORE INSERT ON reconciliation_allocations
  FOR EACH ROW EXECUTE FUNCTION app.trg_recon_alloc_period();

CREATE FUNCTION app.trg_recon_group_period() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM reconciliation_allocations WHERE group_id = OLD.id LOOP
    PERFORM app.assert_movement_open(r.tenant_id, r.left_entity_type, r.left_entity_id);
  END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER recon_group_period_lock BEFORE UPDATE ON reconciliation_groups
  FOR EACH ROW EXECUTE FUNCTION app.trg_recon_group_period();

CREATE FUNCTION app.trg_touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$;
CREATE TRIGGER touch BEFORE UPDATE ON tenants FOR EACH ROW EXECUTE FUNCTION app.trg_touch_updated_at();

-- is_locked: enquanto travada, a operação só aceita o próprio destravamento (via reabertura).
CREATE FUNCTION app.trg_locked_operation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.is_locked AND NEW.is_locked AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
    RAISE EXCEPTION 'RECORD_LOCKED: operação travada em fechamento' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER locked_operation BEFORE UPDATE ON economic_operations
  FOR EACH ROW EXECUTE FUNCTION app.trg_locked_operation();
