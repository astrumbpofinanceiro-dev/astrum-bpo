-- 0013 — Etapa 3: coleta, triagem, lançamento manual e pendências.
-- Colunas fora do Documento 2 (ver docs/etapa-3.md).

-- P1 e P2 (aprovados): destinatário da pendência e tipo de lançamento.
ALTER TABLE blocking_issues
  ADD COLUMN assigned_to_user_id uuid REFERENCES users(id),
  ADD COLUMN response_document_id uuid,
  ADD FOREIGN KEY (tenant_id, response_document_id) REFERENCES documents (tenant_id, id);

ALTER TABLE economic_operations ADD COLUMN entry_type varchar(50)
  CHECK (entry_type IN ('CASH_EXPENSE','DAILY_SALES_SUMMARY','DECLARED_PAYMENT','DECLARED_RECEIPT'));
ALTER TABLE cash_transactions
  ADD COLUMN entry_type varchar(50)
    CHECK (entry_type IN ('CASH_EXPENSE','DAILY_SALES_SUMMARY','DECLARED_PAYMENT','DECLARED_RECEIPT')),
  ADD COLUMN description varchar(300),
  ADD COLUMN missing_receipt_justification text,
  ADD COLUMN review_note text;

-- Doc 1 Exceção 6 pede pendência sobre lançamento de caixa, alvo ausente no Doc 2.
ALTER TABLE blocking_issues DROP CONSTRAINT blocking_issues_target_entity_type_check;
ALTER TABLE blocking_issues ADD CONSTRAINT blocking_issues_target_entity_type_check CHECK (target_entity_type IN
  ('DOCUMENT','BATCH','OPERATION','INSTALLMENT','BANK_TRANSACTION','CASH_TRANSACTION','PERIOD_CLOSING'));

ALTER TABLE documents
  ADD COLUMN rejection_reason varchar(60),
  ADD COLUMN processing_error varchar(120),
  ADD COLUMN review_note text,
  ADD COLUMN duplicate_of_document_id uuid,
  ADD FOREIGN KEY (tenant_id, duplicate_of_document_id) REFERENCES documents (tenant_id, id);

-- "Mesma origem" (Doc 3 §1.3) exige saber a conta ou a adquirente do lote.
ALTER TABLE import_batches
  ADD COLUMN financial_account_id uuid,
  ADD COLUMN acquirer_id uuid,
  ADD COLUMN file_sha256 char(64),
  ADD COLUMN parser_config jsonb,
  ADD FOREIGN KEY (tenant_id, financial_account_id) REFERENCES financial_accounts (tenant_id, id),
  ADD FOREIGN KEY (tenant_id, acquirer_id) REFERENCES acquirers (tenant_id, id);

ALTER TABLE batch_items ADD COLUMN item_note varchar(300);

-- Fila do worker. Fica no schema app (fora da Data API) e guarda apenas identificadores,
-- porque o worker precisa enxergar a fila antes de saber o tenant.
CREATE TABLE app.processing_queue (
  document_id     uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL,
  attempts        integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, document_id) REFERENCES public.documents (tenant_id, id)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON app.processing_queue TO bpo_app;
