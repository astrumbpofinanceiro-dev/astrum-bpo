-- 0015 — Etapa 5: saldo inicial validado, dupla aprovação (D11) e rotina.

ALTER TABLE financial_accounts
  ADD COLUMN balance_validated_at timestamptz,
  ADD COLUMN balance_validated_by uuid REFERENCES users(id);

-- D11: quando a política do cliente exige, a ação fica pendente até outra pessoa decidir.
CREATE TABLE approval_records (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  action               varchar(40) NOT NULL CHECK (action IN
    ('PUBLISH_WITH_CAVEATS','REOPEN','REFUND','REVERSE_SETTLEMENT','REVERSE_ANTICIPATION')),
  target_id            uuid,
  payload              jsonb NOT NULL,
  status               varchar(20) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  requested_by_user_id uuid NOT NULL REFERENCES users(id),
  decided_by_user_id   uuid REFERENCES users(id),
  decided_at           timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (decided_by_user_id IS NULL OR decided_by_user_id <> requested_by_user_id OR status = 'REJECTED'),
  CHECK (status = 'PENDING' OR decided_by_user_id IS NOT NULL)
);
CREATE INDEX idx_approvals_pending ON approval_records (tenant_id, status);
ALTER TABLE approval_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_records FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON approval_records
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
GRANT SELECT, INSERT, UPDATE ON approval_records TO bpo_app;
CREATE TRIGGER no_delete BEFORE DELETE ON approval_records FOR EACH ROW EXECUTE FUNCTION app.trg_forbid();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON approval_records FOR EACH STATEMENT EXECUTE FUNCTION app.trg_forbid();
CREATE TRIGGER audit AFTER INSERT OR UPDATE ON approval_records FOR EACH ROW EXECUTE FUNCTION app.trg_audit();

CREATE UNIQUE INDEX uq_routine_item_due ON routine_items (routine_id, due_date);
