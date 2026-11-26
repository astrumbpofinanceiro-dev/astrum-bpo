-- 0008 — Limites de alocação, estado de conciliação e regras de transição críticas

-- ========== Antecipação (Doc 1 §2.4, Doc 3 §3.2) ==========
-- Consumo do bruto da parcela = antecipações + liquidações que NÃO vêm de antecipação.
CREATE FUNCTION app.check_installment_cap(p_installment uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_gross numeric(15,2); v_used numeric;
BEGIN
  SELECT gross_amount INTO v_gross FROM obligation_installments WHERE id = p_installment FOR NO KEY UPDATE;
  SELECT COALESCE((SELECT SUM(gross_allocated) FROM anticipation_allocations WHERE installment_id = p_installment), 0)
       + COALESCE((SELECT SUM(sa.allocated_gross_amount) FROM settlement_allocations sa
                   JOIN settlement_events se ON se.id = sa.settlement_event_id
                   WHERE sa.installment_id = p_installment AND se.anticipation_id IS NULL), 0)
    INTO v_used;
  IF v_used > v_gross THEN
    RAISE EXCEPTION 'ALLOCATION_EXCEEDS_BALANCE: parcela % alocada % > bruto %', p_installment, v_used, v_gross
      USING ERRCODE = 'check_violation';
  END IF;
END $$;

CREATE FUNCTION app.trg_anticipation_alloc_cap() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a receivable_anticipations; s record;
BEGIN
  PERFORM app.check_installment_cap(NEW.installment_id);
  SELECT * INTO a FROM receivable_anticipations WHERE id = NEW.anticipation_id FOR NO KEY UPDATE;
  SELECT SUM(gross_allocated) g, SUM(fee_allocated) f, SUM(net_allocated) n INTO s
    FROM anticipation_allocations WHERE anticipation_id = NEW.anticipation_id;
  IF s.g > a.gross_anticipated_amount OR s.f > a.anticipation_fee_amount OR s.n > a.net_anticipated_amount THEN
    RAISE EXCEPTION 'ALLOCATION_EXCEEDS_BALANCE: alocações excedem a antecipação %', a.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER anticipation_alloc_cap AFTER INSERT OR UPDATE ON anticipation_allocations
  FOR EACH ROW EXECUTE FUNCTION app.trg_anticipation_alloc_cap();

CREATE FUNCTION app.trg_settlement_alloc_cap() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e settlement_events; v_sum numeric; v_antic numeric;
BEGIN
  SELECT * INTO e FROM settlement_events WHERE id = NEW.settlement_event_id FOR NO KEY UPDATE;
  PERFORM app.check_installment_cap(NEW.installment_id);
  SELECT COALESCE(SUM(allocated_gross_amount),0) INTO v_sum FROM settlement_allocations WHERE settlement_event_id = e.id;
  IF v_sum > e.gross_amount THEN
    RAISE EXCEPTION 'ALLOCATION_EXCEEDS_BALANCE: alocações excedem a liquidação %', e.id USING ERRCODE = 'check_violation';
  END IF;
  IF e.anticipation_id IS NOT NULL THEN
    SELECT COALESCE(SUM(gross_allocated),0) INTO v_antic FROM anticipation_allocations
      WHERE anticipation_id = e.anticipation_id AND installment_id = NEW.installment_id;
    SELECT COALESCE(SUM(sa.allocated_gross_amount),0) INTO v_sum FROM settlement_allocations sa
      JOIN settlement_events se ON se.id = sa.settlement_event_id
      WHERE se.anticipation_id = e.anticipation_id AND sa.installment_id = NEW.installment_id;
    IF v_sum > v_antic THEN
      RAISE EXCEPTION 'ALLOCATION_EXCEEDS_BALANCE: liquidação excede o valor antecipado da parcela'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER settlement_alloc_cap AFTER INSERT OR UPDATE ON settlement_allocations
  FOR EACH ROW EXECUTE FUNCTION app.trg_settlement_alloc_cap();

-- O vínculo com a antecipação não muda depois de criado (senão burlaria o limite acima).
CREATE FUNCTION app.trg_settlement_link_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.anticipation_id IS DISTINCT FROM OLD.anticipation_id THEN
    RAISE EXCEPTION 'IMMUTABLE_FIELD: settlement_events.anticipation_id';
  END IF;
  IF NEW.gross_amount < (SELECT COALESCE(SUM(allocated_gross_amount),0) FROM settlement_allocations
                         WHERE settlement_event_id = NEW.id) THEN
    RAISE EXCEPTION 'ALLOCATION_EXCEEDS_BALANCE: bruto menor que o já alocado' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER settlement_link_immutable BEFORE UPDATE ON settlement_events
  FOR EACH ROW EXECUTE FUNCTION app.trg_settlement_link_immutable();

CREATE FUNCTION app.trg_installment_gross_floor() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.gross_amount < OLD.gross_amount THEN PERFORM app.check_installment_cap(NEW.id); END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER installment_gross_floor AFTER UPDATE OF gross_amount ON obligation_installments
  FOR EACH ROW EXECUTE FUNCTION app.trg_installment_gross_floor();

-- ========== Conciliação (Doc 3 §2.2) ==========
CREATE FUNCTION app.allocated_left(p_type text, p_id uuid) RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT COALESCE(SUM(a.allocated_amount), 0) FROM reconciliation_allocations a
  JOIN reconciliation_groups g ON g.id = a.group_id
  WHERE g.status = 'ACTIVE' AND a.left_entity_type = p_type AND a.left_entity_id = p_id
$$;

CREATE FUNCTION app.recon_status(p_alloc numeric, p_total numeric) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_alloc = 0 THEN 'UNRECONCILED' WHEN p_alloc < p_total THEN 'PARTIALLY_RECONCILED' ELSE 'RECONCILED' END
$$;

CREATE FUNCTION app.refresh_recon(p_type text, p_id uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_type = 'BANK_TRANSACTION' THEN
    UPDATE bank_transactions SET reconciliation_status = app.recon_status(app.allocated_left(p_type, p_id), amount)
     WHERE id = p_id;
  ELSIF p_type = 'CASH_TRANSACTION' THEN
    UPDATE cash_transactions SET reconciliation_status = app.recon_status(app.allocated_left(p_type, p_id), amount)
     WHERE id = p_id;
  ELSIF p_type = 'INTERNAL_TRANSFER' THEN  -- duas pernas: total = 2 x valor
    UPDATE internal_transfers t SET reconciliation_status = app.recon_status(
      (SELECT COALESCE(SUM(a.allocated_amount),0) FROM reconciliation_allocations a
        JOIN reconciliation_groups g ON g.id = a.group_id
        WHERE g.status = 'ACTIVE' AND a.right_entity_type = p_type AND a.right_entity_id = p_id), t.amount * 2)
     WHERE t.id = p_id;
  END IF;
END $$;

CREATE FUNCTION app.trg_recon_alloc() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_total numeric; v_used numeric; v_dir text; v_group text;
BEGIN
  SELECT status INTO v_group FROM reconciliation_groups WHERE id = NEW.group_id FOR NO KEY UPDATE;
  IF v_group IS DISTINCT FROM 'ACTIVE' THEN
    RAISE EXCEPTION 'RECONCILIATION_GROUP_NOT_ACTIVE';
  END IF;

  IF NEW.left_entity_type = 'BANK_TRANSACTION' THEN
    SELECT amount, direction INTO v_total, v_dir FROM bank_transactions
     WHERE id = NEW.left_entity_id AND tenant_id = NEW.tenant_id FOR NO KEY UPDATE;
  ELSE
    SELECT amount, CASE direction WHEN 'INFLOW' THEN 'CREDIT' ELSE 'DEBIT' END INTO v_total, v_dir
      FROM cash_transactions WHERE id = NEW.left_entity_id AND tenant_id = NEW.tenant_id AND deleted_at IS NULL FOR NO KEY UPDATE;
  END IF;
  IF v_total IS NULL THEN RAISE EXCEPTION 'RECONCILIATION_TARGET_NOT_FOUND: %', NEW.left_entity_type
    USING ERRCODE = 'foreign_key_violation'; END IF;
  IF app.allocated_left(NEW.left_entity_type, NEW.left_entity_id) > v_total THEN
    RAISE EXCEPTION 'ALLOCATION_EXCEEDS_BALANCE: movimentação %', NEW.left_entity_id USING ERRCODE = 'check_violation';
  END IF;

  v_total := NULL;
  IF NEW.right_entity_type = 'SETTLEMENT_EVENT' THEN
    SELECT abs(net_amount) INTO v_total FROM settlement_events WHERE id = NEW.right_entity_id AND tenant_id = NEW.tenant_id FOR NO KEY UPDATE;
  ELSIF NEW.right_entity_type = 'OBLIGATION_INSTALLMENT' THEN
    SELECT gross_amount INTO v_total FROM obligation_installments WHERE id = NEW.right_entity_id AND tenant_id = NEW.tenant_id FOR NO KEY UPDATE;
  ELSE
    SELECT amount INTO v_total FROM internal_transfers WHERE id = NEW.right_entity_id AND tenant_id = NEW.tenant_id FOR NO KEY UPDATE;
  END IF;
  IF v_total IS NULL THEN RAISE EXCEPTION 'RECONCILIATION_TARGET_NOT_FOUND: %', NEW.right_entity_type
    USING ERRCODE = 'foreign_key_violation'; END IF;

  -- Transferência interna: o limite vale por perna (saída e entrada separadas).
  SELECT COALESCE(SUM(a.allocated_amount),0) INTO v_used
    FROM reconciliation_allocations a
    JOIN reconciliation_groups g ON g.id = a.group_id AND g.status = 'ACTIVE'
    LEFT JOIN bank_transactions b ON a.left_entity_type = 'BANK_TRANSACTION' AND b.id = a.left_entity_id
    LEFT JOIN cash_transactions c ON a.left_entity_type = 'CASH_TRANSACTION' AND c.id = a.left_entity_id
   WHERE a.right_entity_type = NEW.right_entity_type AND a.right_entity_id = NEW.right_entity_id
     AND (NEW.right_entity_type <> 'INTERNAL_TRANSFER'
          OR COALESCE(b.direction, CASE c.direction WHEN 'INFLOW' THEN 'CREDIT' ELSE 'DEBIT' END) = v_dir);
  IF v_used > v_total THEN
    RAISE EXCEPTION 'ALLOCATION_EXCEEDS_BALANCE: destino %', NEW.right_entity_id USING ERRCODE = 'check_violation';
  END IF;

  PERFORM app.refresh_recon(NEW.left_entity_type, NEW.left_entity_id);
  IF NEW.right_entity_type = 'INTERNAL_TRANSFER' THEN
    PERFORM app.refresh_recon('INTERNAL_TRANSFER', NEW.right_entity_id);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER recon_alloc_cap AFTER INSERT ON reconciliation_allocations
  FOR EACH ROW EXECUTE FUNCTION app.trg_recon_alloc();

-- Desfazer = marcar o grupo como REVERSED. Terminal; alocações permanecem no histórico.
CREATE FUNCTION app.trg_recon_group_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'REVERSED' THEN RAISE EXCEPTION 'IMMUTABLE_RECORD: grupo de conciliação já revertido'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER recon_group_guard BEFORE UPDATE ON reconciliation_groups
  FOR EACH ROW EXECUTE FUNCTION app.trg_recon_group_guard();

CREATE FUNCTION app.trg_recon_group_reversed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM reconciliation_allocations WHERE group_id = NEW.id LOOP
    PERFORM app.refresh_recon(r.left_entity_type, r.left_entity_id);
    IF r.right_entity_type = 'INTERNAL_TRANSFER' THEN
      PERFORM app.refresh_recon('INTERNAL_TRANSFER', r.right_entity_id);
    END IF;
  END LOOP;
  RETURN NULL;
END $$;
CREATE TRIGGER recon_group_reversed AFTER UPDATE OF status ON reconciliation_groups
  FOR EACH ROW WHEN (NEW.status = 'REVERSED') EXECUTE FUNCTION app.trg_recon_group_reversed();

-- ========== Lançamento do cliente (Doc 1 §2.3) ==========
CREATE FUNCTION app.trg_client_entry_initial_status() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.origin_type IN ('CLIENT_MASTER_ENTRY','CLIENT_EMPLOYEE_ENTRY')
     AND NEW.review_status NOT IN ('DRAFT','SUBMITTED_PENDING_BPO') THEN
    RAISE EXCEPTION 'CLIENT_ENTRY_REQUIRES_BPO_REVIEW' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER client_entry_status BEFORE INSERT ON economic_operations
  FOR EACH ROW EXECUTE FUNCTION app.trg_client_entry_initial_status();
CREATE TRIGGER client_entry_status BEFORE INSERT ON cash_transactions
  FOR EACH ROW EXECUTE FUNCTION app.trg_client_entry_initial_status();

-- ========== Pendências (Doc 1 §2.6) ==========
CREATE FUNCTION app.trg_issue_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.severity IN ('BLOCKING_OPERATIONAL','CRITICAL') AND NEW.status = 'RESOLVED' THEN
    IF TG_OP = 'INSERT' OR (OLD.status <> 'RESOLVED'
        AND OLD.status NOT IN ('ANSWERED_PENDING_BPO_VALIDATION','WAITING_BPO_ACTION')) THEN
      RAISE EXCEPTION 'ISSUE_REQUIRES_BPO_VALIDATION' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.resolved_by_user_id IS NULL OR NEW.resolved_at IS NULL THEN
      RAISE EXCEPTION 'ISSUE_RESOLUTION_REQUIRES_RESOLVER' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER issue_guard BEFORE INSERT OR UPDATE ON blocking_issues
  FOR EACH ROW EXECUTE FUNCTION app.trg_issue_guard();

-- ========== Valor do registro não pode ficar abaixo do já alocado ==========
CREATE FUNCTION app.trg_movement_floor() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_type text := TG_ARGV[0]; v_used numeric;
BEGIN
  v_used := app.allocated_left(v_type, NEW.id);
  IF NEW.amount < v_used THEN
    RAISE EXCEPTION 'ALLOCATION_EXCEEDS_BALANCE: valor menor que o já conciliado' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM app.refresh_recon(v_type, NEW.id);
  RETURN NULL;
END $$;
CREATE TRIGGER movement_floor AFTER UPDATE OF amount ON bank_transactions
  FOR EACH ROW WHEN (NEW.amount <> OLD.amount) EXECUTE FUNCTION app.trg_movement_floor('BANK_TRANSACTION');
CREATE TRIGGER movement_floor AFTER UPDATE OF amount ON cash_transactions
  FOR EACH ROW WHEN (NEW.amount <> OLD.amount) EXECUTE FUNCTION app.trg_movement_floor('CASH_TRANSACTION');

CREATE FUNCTION app.trg_anticipation_floor() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM anticipation_allocations WHERE anticipation_id = NEW.id
             HAVING SUM(gross_allocated) > NEW.gross_anticipated_amount
                 OR SUM(fee_allocated) > NEW.anticipation_fee_amount
                 OR SUM(net_allocated) > NEW.net_anticipated_amount) THEN
    RAISE EXCEPTION 'ALLOCATION_EXCEEDS_BALANCE: antecipação menor que o já alocado' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER anticipation_floor AFTER UPDATE ON receivable_anticipations
  FOR EACH ROW EXECUTE FUNCTION app.trg_anticipation_floor();
