-- 0007 — COMPLEMENTOS NÃO PREVISTOS NO DOCUMENTO 2. PENDENTES DE APROVAÇÃO.
-- Cada bloco existe porque outro documento exige a informação.
-- Detalhes em docs/decisoes-pendentes.md.

-- C1. Doc 3 §3.3: o estorno é "vinculado à venda original".
ALTER TABLE economic_operations ADD COLUMN reversal_of_operation_id uuid;
ALTER TABLE economic_operations
  ADD FOREIGN KEY (tenant_id, reversal_of_operation_id) REFERENCES economic_operations (tenant_id, id),
  ADD CONSTRAINT ck_ops_reversal_link
    CHECK ((operation_type = 'REFUND_REVERSAL') = (reversal_of_operation_id IS NOT NULL));

-- C2. Doc 1 §2.5: caixa e transferências também têm estado de conciliação.
ALTER TABLE cash_transactions ADD COLUMN reconciliation_status varchar(30) NOT NULL DEFAULT 'UNRECONCILED'
  CHECK (reconciliation_status IN ('UNRECONCILED','SUGGESTED_MATCH','PARTIALLY_RECONCILED','RECONCILED','EXCEPTION'));
ALTER TABLE internal_transfers ADD COLUMN reconciliation_status varchar(30) NOT NULL DEFAULT 'UNRECONCILED'
  CHECK (reconciliation_status IN ('UNRECONCILED','SUGGESTED_MATCH','PARTIALLY_RECONCILED','RECONCILED','EXCEPTION'));

-- C3. Liga a liquidação à antecipação que a originou (evita contar o mesmo bruto duas vezes).
ALTER TABLE settlement_events ADD COLUMN anticipation_id uuid;
ALTER TABLE settlement_events
  ADD FOREIGN KEY (tenant_id, anticipation_id) REFERENCES receivable_anticipations (tenant_id, id);

-- C4. Doc 1 §2.7 e Doc 3 §5.2: responsável posterior e pendências ressalvadas.
ALTER TABLE closing_versions ADD COLUMN caveat_responsible_user_id uuid REFERENCES users(id);
ALTER TABLE closing_versions ADD CONSTRAINT ck_caveat_responsible
  CHECK (closing_type <> 'PUBLISHED_WITH_CAVEATS' OR caveat_responsible_user_id IS NOT NULL);

CREATE TABLE closing_version_issues (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  closing_version_id uuid NOT NULL,
  blocking_issue_id  uuid NOT NULL,
  UNIQUE (closing_version_id, blocking_issue_id),
  FOREIGN KEY (tenant_id, closing_version_id) REFERENCES closing_versions (tenant_id, id),
  FOREIGN KEY (tenant_id, blocking_issue_id)  REFERENCES blocking_issues (tenant_id, id)
);

-- C5. Doc 3 §6: toda chamada de IA grava ai_processing_logs.
CREATE TABLE ai_processing_logs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  model               varchar(80) NOT NULL,
  input_tokens        integer NOT NULL CHECK (input_tokens >= 0),
  output_tokens       integer NOT NULL CHECK (output_tokens >= 0),
  estimated_cost      numeric(15,6) NOT NULL CHECK (estimated_cost >= 0), -- custo unitário < 1 centavo
  reason              text NOT NULL,
  human_review_status varchar(30) NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_ai_logs_tenant ON ai_processing_logs (tenant_id, created_at);

-- C6. Estrutura v3.1 §16: origem (interface, API, job, importação) e correlação.
ALTER TABLE audit_logs ADD COLUMN source varchar(20), ADD COLUMN correlation_id uuid;
