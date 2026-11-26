-- 0014 — Etapa 4: decisões D7 a D10 aprovadas em 26/11/2026.

-- D8: estorno de parcela em aberto é anotado à parte; o bruto original não muda.
ALTER TABLE obligation_installments
  ADD COLUMN cancelled_amount numeric(15,2) NOT NULL DEFAULT 0.00 CHECK (cancelled_amount >= 0),
  ADD CONSTRAINT ck_installment_balance CHECK (settled_amount + cancelled_amount <= gross_amount);
DROP TRIGGER period_lock ON obligation_installments;
CREATE TRIGGER period_lock BEFORE INSERT OR UPDATE ON obligation_installments FOR EACH ROW EXECUTE FUNCTION
  app.trg_period_lock('installment', 'status', 'settled_amount', 'cancelled_amount', 'current_expected_settlement_date');

-- D10: liquidação e antecipação erradas são marcadas como estornadas.
ALTER TABLE settlement_events
  ADD COLUMN status varchar(20) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','REVERSED')),
  ADD COLUMN reversal_reason text,
  ADD CONSTRAINT ck_settlement_reversal CHECK (status = 'ACTIVE' OR reversal_reason IS NOT NULL);
ALTER TABLE receivable_anticipations
  ADD COLUMN status varchar(20) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','REVERSED')),
  ADD COLUMN reversal_reason text,
  ADD CONSTRAINT ck_anticipation_reversal CHECK (status = 'ACTIVE' OR reversal_reason IS NOT NULL);

-- D7: taxa pertence à competência da venda de origem (bloqueio de período pela própria competência).
ALTER TABLE settlement_fee_items
  ADD COLUMN installment_id uuid,
  ADD COLUMN competence_date date,
  ADD FOREIGN KEY (tenant_id, installment_id) REFERENCES obligation_installments (tenant_id, id);
DROP TRIGGER period_lock ON settlement_fee_items;
CREATE TRIGGER period_lock BEFORE INSERT OR UPDATE ON settlement_fee_items
  FOR EACH ROW EXECUTE FUNCTION app.trg_period_lock('competence_date');

-- D9: juros e multa registrados à parte, com justificativa, ligados à parcela.
CREATE TABLE installment_charges (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  installment_id          uuid NOT NULL,
  reconciliation_group_id uuid NOT NULL,
  charge_type             varchar(20) NOT NULL CHECK (charge_type IN ('INTEREST','FINE')),
  amount                  numeric(15,2) NOT NULL CHECK (amount > 0),
  competence_date         date NOT NULL,
  justification           text NOT NULL CHECK (char_length(btrim(justification)) >= 10),
  created_by_user_id      uuid NOT NULL REFERENCES users(id),
  created_at              timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, installment_id) REFERENCES obligation_installments (tenant_id, id),
  FOREIGN KEY (tenant_id, reconciliation_group_id) REFERENCES reconciliation_groups (tenant_id, id)
);
CREATE INDEX idx_charges_installment ON installment_charges (tenant_id, installment_id);
ALTER TABLE installment_charges ENABLE ROW LEVEL SECURITY;
ALTER TABLE installment_charges FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON installment_charges
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
GRANT SELECT, INSERT ON installment_charges TO bpo_app;
CREATE TRIGGER no_delete BEFORE DELETE ON installment_charges FOR EACH ROW EXECUTE FUNCTION app.trg_forbid();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON installment_charges FOR EACH STATEMENT EXECUTE FUNCTION app.trg_forbid();
CREATE TRIGGER no_update BEFORE UPDATE ON installment_charges FOR EACH ROW EXECUTE FUNCTION app.trg_forbid();
CREATE TRIGGER audit AFTER INSERT ON installment_charges FOR EACH ROW EXECUTE FUNCTION app.trg_audit();
CREATE TRIGGER period_lock BEFORE INSERT ON installment_charges
  FOR EACH ROW EXECUTE FUNCTION app.trg_period_lock('competence_date');

-- ========== Saldo da parcela ==========
CREATE FUNCTION app.installment_charges_total(p uuid) RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT COALESCE(SUM(c.amount), 0) FROM installment_charges c
   JOIN reconciliation_groups g ON g.id = c.reconciliation_group_id AND g.status = 'ACTIVE'
  WHERE c.installment_id = p
$$;

-- Principal já consumido: antecipações, liquidações diretas, conciliações (sem juros/multa) e estornos
-- descontados em repasse. Registros estornados não contam.
CREATE FUNCTION app.installment_settled(p uuid) RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT
    COALESCE((SELECT SUM(a.gross_allocated) FROM anticipation_allocations a
               JOIN receivable_anticipations r ON r.id = a.anticipation_id AND r.status = 'ACTIVE'
              WHERE a.installment_id = p), 0)
  + COALESCE((SELECT SUM(s.allocated_gross_amount) FROM settlement_allocations s
               JOIN settlement_events e ON e.id = s.settlement_event_id AND e.status = 'ACTIVE' AND e.anticipation_id IS NULL
              WHERE s.installment_id = p), 0)
  + COALESCE((SELECT SUM(f.amount) FROM settlement_fee_items f
               JOIN settlement_events e ON e.id = f.settlement_event_id AND e.status = 'ACTIVE'
              WHERE f.installment_id = p AND f.fee_type = 'CHARGEBACK'), 0)
  + GREATEST(0, COALESCE((SELECT SUM(a.allocated_amount) FROM reconciliation_allocations a
               JOIN reconciliation_groups g ON g.id = a.group_id AND g.status = 'ACTIVE'
              WHERE a.right_entity_type = 'OBLIGATION_INSTALLMENT' AND a.right_entity_id = p), 0)
      - app.installment_charges_total(p))
$$;

CREATE FUNCTION app.refresh_installment(p uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE i obligation_installments; v numeric; v_antic date;
BEGIN
  SELECT * INTO i FROM obligation_installments WHERE id = p FOR NO KEY UPDATE;
  v := app.installment_settled(p);
  IF v + i.cancelled_amount > i.gross_amount THEN
    RAISE EXCEPTION 'ALLOCATION_EXCEEDS_BALANCE: parcela %', p USING ERRCODE = 'check_violation';
  END IF;
  SELECT MAX(r.effective_date) INTO v_antic FROM anticipation_allocations a
    JOIN receivable_anticipations r ON r.id = a.anticipation_id AND r.status = 'ACTIVE' WHERE a.installment_id = p;
  UPDATE obligation_installments SET
    settled_amount = v,
    -- Doc 3 §3.2: só a parcela totalmente consumida muda de data; o saldo restante fica na data original.
    current_expected_settlement_date = CASE WHEN v_antic IS NOT NULL AND v + cancelled_amount = gross_amount
      THEN v_antic ELSE current_expected_settlement_date END,
    status = CASE
      WHEN status = 'WRITTEN_OFF' THEN status
      WHEN cancelled_amount = gross_amount THEN 'CANCELLED'
      WHEN v + cancelled_amount = gross_amount THEN CASE WHEN v_antic IS NULL THEN 'SETTLED' ELSE 'ANTICIPATED_SETTLED' END
      WHEN v > 0 THEN 'PARTIALLY_SETTLED'
      ELSE 'OPEN' END
   WHERE id = p;
  UPDATE financial_obligations o SET status = (
      SELECT CASE WHEN bool_and(status = 'CANCELLED') THEN 'CANCELLED'
                  WHEN bool_and(status IN ('SETTLED','ANTICIPATED_SETTLED','CANCELLED','WRITTEN_OFF')) THEN 'SETTLED'
                  WHEN bool_or(settled_amount > 0) THEN 'PARTIALLY_SETTLED' ELSE 'OPEN' END
        FROM obligation_installments WHERE obligation_id = o.id)
   WHERE o.id = i.obligation_id;
END $$;

-- Substitui o limite da 0008, agora considerando cancelamentos e estornos.
CREATE OR REPLACE FUNCTION app.check_installment_cap(p_installment uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE i obligation_installments;
BEGIN
  SELECT * INTO i FROM obligation_installments WHERE id = p_installment FOR NO KEY UPDATE;
  IF app.installment_settled(p_installment) + i.cancelled_amount > i.gross_amount THEN
    RAISE EXCEPTION 'ALLOCATION_EXCEEDS_BALANCE: parcela %', p_installment USING ERRCODE = 'check_violation';
  END IF;
END $$;

CREATE FUNCTION app.trg_refresh_from_child() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.installment_id IS NOT NULL THEN PERFORM app.refresh_installment(NEW.installment_id); END IF;
  RETURN NULL;
END $$;
-- Nome posterior em ordem alfabética aos gatilhos de limite da 0008.
CREATE TRIGGER zz_refresh AFTER INSERT OR UPDATE ON anticipation_allocations FOR EACH ROW EXECUTE FUNCTION app.trg_refresh_from_child();
CREATE TRIGGER zz_refresh AFTER INSERT OR UPDATE ON settlement_allocations FOR EACH ROW EXECUTE FUNCTION app.trg_refresh_from_child();
CREATE TRIGGER zz_refresh AFTER INSERT ON settlement_fee_items
  FOR EACH ROW WHEN (NEW.fee_type = 'CHARGEBACK') EXECUTE FUNCTION app.trg_refresh_from_child();

CREATE FUNCTION app.trg_refresh_cancel() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM app.refresh_installment(NEW.id); RETURN NULL; END $$;
CREATE TRIGGER zz_refresh_cancel AFTER UPDATE OF cancelled_amount ON obligation_installments
  FOR EACH ROW WHEN (NEW.cancelled_amount IS DISTINCT FROM OLD.cancelled_amount) EXECUTE FUNCTION app.trg_refresh_cancel();

CREATE FUNCTION app.trg_recon_installment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.right_entity_type = 'OBLIGATION_INSTALLMENT' THEN PERFORM app.refresh_installment(NEW.right_entity_id); END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER zz_recon_installment AFTER INSERT ON reconciliation_allocations
  FOR EACH ROW EXECUTE FUNCTION app.trg_recon_installment();

CREATE FUNCTION app.trg_recon_reversed_installments() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r record;
BEGIN
  FOR r IN SELECT right_entity_id FROM reconciliation_allocations
            WHERE group_id = NEW.id AND right_entity_type = 'OBLIGATION_INSTALLMENT' LOOP
    PERFORM app.refresh_installment(r.right_entity_id);
  END LOOP;
  RETURN NULL;
END $$;
CREATE TRIGGER zz_recon_reversed AFTER UPDATE OF status ON reconciliation_groups
  FOR EACH ROW WHEN (NEW.status = 'REVERSED') EXECUTE FUNCTION app.trg_recon_reversed_installments();

-- Estorno é terminal; não se estorna o que está conciliado.
CREATE FUNCTION app.trg_reversal_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'REVERSED' THEN RAISE EXCEPTION 'IMMUTABLE_RECORD: registro já estornado'; END IF;
  IF NEW.status = 'REVERSED' AND TG_TABLE_NAME = 'settlement_events' AND EXISTS (
       SELECT 1 FROM reconciliation_allocations a JOIN reconciliation_groups g ON g.id = a.group_id AND g.status = 'ACTIVE'
        WHERE a.right_entity_type = 'SETTLEMENT_EVENT' AND a.right_entity_id = NEW.id) THEN
    RAISE EXCEPTION 'REVERSE_RECONCILIATION_FIRST' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER reversal_guard BEFORE UPDATE ON settlement_events FOR EACH ROW EXECUTE FUNCTION app.trg_reversal_guard();
CREATE TRIGGER reversal_guard BEFORE UPDATE ON receivable_anticipations FOR EACH ROW EXECUTE FUNCTION app.trg_reversal_guard();

CREATE FUNCTION app.trg_event_reversed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r record;
BEGIN
  FOR r IN SELECT installment_id FROM settlement_allocations WHERE settlement_event_id = NEW.id
           UNION SELECT installment_id FROM settlement_fee_items
                  WHERE settlement_event_id = NEW.id AND installment_id IS NOT NULL LOOP
    PERFORM app.refresh_installment(r.installment_id);
  END LOOP;
  RETURN NULL;
END $$;
CREATE TRIGGER event_reversed AFTER UPDATE OF status ON settlement_events
  FOR EACH ROW WHEN (NEW.status = 'REVERSED') EXECUTE FUNCTION app.trg_event_reversed();

CREATE FUNCTION app.trg_anticipation_reversed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r record;
BEGIN
  FOR r IN SELECT installment_id FROM anticipation_allocations WHERE anticipation_id = NEW.id LOOP
    -- volta à previsão original antes de recalcular
    UPDATE obligation_installments SET current_expected_settlement_date = original_expected_settlement_date
     WHERE id = r.installment_id;
    PERFORM app.refresh_installment(r.installment_id);
  END LOOP;
  RETURN NULL;
END $$;
CREATE TRIGGER anticipation_reversed AFTER UPDATE OF status ON receivable_anticipations
  FOR EACH ROW WHEN (NEW.status = 'REVERSED') EXECUTE FUNCTION app.trg_anticipation_reversed();

-- Redefinição do limite de conciliação (0008).
CREATE OR REPLACE FUNCTION app.trg_recon_alloc() RETURNS trigger LANGUAGE plpgsql AS $$
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
    SELECT abs(net_amount) INTO v_total FROM settlement_events
     WHERE id = NEW.right_entity_id AND tenant_id = NEW.tenant_id AND status = 'ACTIVE' FOR NO KEY UPDATE;
  ELSIF NEW.right_entity_type = 'OBLIGATION_INSTALLMENT' THEN
    SELECT gross_amount - cancelled_amount + app.installment_charges_total(id) INTO v_total FROM obligation_installments
     WHERE id = NEW.right_entity_id AND tenant_id = NEW.tenant_id FOR NO KEY UPDATE;
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
