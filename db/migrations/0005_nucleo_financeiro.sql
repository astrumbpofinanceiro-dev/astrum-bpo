-- 0005 — Domínio D: núcleo financeiro, cartões, liquidações e conciliação (Doc 2 §5)
CREATE TABLE economic_operations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  business_unit_id   uuid,
  operation_type     varchar(30) NOT NULL CHECK (operation_type IN ('SALE','SERVICE','PURCHASE','EXPENSE','REFUND_REVERSAL')),
  origin_type        varchar(30) NOT NULL CHECK (origin_type IN ('BPO_ENTRY','CLIENT_MASTER_ENTRY','CLIENT_EMPLOYEE_ENTRY','BATCH_IMPORT')),
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  source_document_id uuid,
  acquirer_id        uuid,
  external_nsu_tid   varchar(100),
  category_id        uuid,
  cost_center_id     uuid,
  operation_date     date NOT NULL,
  competence_date    date NOT NULL,
  gross_amount       numeric(15,2) NOT NULL CHECK (gross_amount >= 0),
  currency_code      char(3) NOT NULL DEFAULT 'BRL',
  description        varchar(300) NOT NULL,
  review_status      varchar(30) NOT NULL DEFAULT 'SUBMITTED_PENDING_BPO'
    CHECK (review_status IN ('DRAFT','SUBMITTED_PENDING_BPO','UNDER_BPO_REVIEW','APPROVED_FOR_LEDGER',
           'RETURNED_FOR_CORRECTION','REJECTED','LOCKED_IN_CLOSING')),
  is_locked          boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, business_unit_id)   REFERENCES business_units (tenant_id, id),
  FOREIGN KEY (tenant_id, source_document_id) REFERENCES documents (tenant_id, id),
  FOREIGN KEY (tenant_id, acquirer_id)        REFERENCES acquirers (tenant_id, id),
  FOREIGN KEY (tenant_id, category_id)        REFERENCES accounting_categories (tenant_id, id),
  FOREIGN KEY (tenant_id, cost_center_id)     REFERENCES cost_centers (tenant_id, id)
);
CREATE INDEX idx_ops_competence ON economic_operations (tenant_id, competence_date, operation_type, review_status);
CREATE INDEX idx_ops_nsu ON economic_operations (tenant_id, acquirer_id, external_nsu_tid) WHERE external_nsu_tid IS NOT NULL;

CREATE TABLE financial_obligations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  economic_operation_id uuid,
  direction             varchar(15) NOT NULL CHECK (direction IN ('RECEIVABLE','PAYABLE')),
  counterparty_name     varchar(180),
  total_amount          numeric(15,2) NOT NULL CHECK (total_amount >= 0),
  status                varchar(30) NOT NULL CHECK (status IN ('OPEN','PARTIALLY_SETTLED','SETTLED','CANCELLED')),
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, economic_operation_id) REFERENCES economic_operations (tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX idx_obligations_op ON financial_obligations (tenant_id, economic_operation_id);

CREATE TABLE obligation_installments (
  id                                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                         uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  obligation_id                     uuid NOT NULL,
  installment_number                integer NOT NULL,
  total_installments                integer NOT NULL,
  gross_amount                      numeric(15,2) NOT NULL CHECK (gross_amount >= 0),
  expected_fee_amount               numeric(15,2) NOT NULL DEFAULT 0.00 CHECK (expected_fee_amount >= 0),
  net_expected_amount               numeric(15,2) NOT NULL,
  settled_amount                    numeric(15,2) NOT NULL DEFAULT 0.00 CHECK (settled_amount >= 0),
  due_date                          date NOT NULL,
  original_expected_settlement_date date NOT NULL,
  current_expected_settlement_date  date NOT NULL,
  status                            varchar(30) NOT NULL CHECK (status IN ('OPEN','PARTIALLY_SETTLED',
    'SETTLED','ANTICIPATED_SETTLED','OVERDUE','CANCELLED','WRITTEN_OFF')),
  CHECK (settled_amount <= gross_amount),
  CHECK (installment_number BETWEEN 1 AND total_installments),
  CHECK (net_expected_amount = gross_amount - expected_fee_amount),  -- Doc 3 §3.1
  UNIQUE (obligation_id, installment_number),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, obligation_id) REFERENCES financial_obligations (tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX idx_installments_forecast ON obligation_installments (tenant_id, status, current_expected_settlement_date);
CREATE INDEX idx_installments_due ON obligation_installments (tenant_id, status, due_date);

CREATE TABLE receivable_anticipations (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  acquirer_id              uuid NOT NULL,
  requested_at             date NOT NULL,
  effective_date           date NOT NULL,
  gross_anticipated_amount numeric(15,2) NOT NULL CHECK (gross_anticipated_amount > 0),
  anticipation_fee_amount  numeric(15,2) NOT NULL CHECK (anticipation_fee_amount >= 0),
  net_anticipated_amount   numeric(15,2) NOT NULL CHECK (net_anticipated_amount >= 0),
  source_document_id       uuid,
  created_at               timestamptz NOT NULL DEFAULT now(),
  -- "<=" e não "=": o líquido também pode descontar o MDR (Doc 3, Cenário 4).
  CHECK (net_anticipated_amount <= gross_anticipated_amount - anticipation_fee_amount),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, acquirer_id)        REFERENCES acquirers (tenant_id, id),
  FOREIGN KEY (tenant_id, source_document_id) REFERENCES documents (tenant_id, id)
);

CREATE TABLE anticipation_allocations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  anticipation_id uuid NOT NULL,
  installment_id  uuid NOT NULL,
  gross_allocated numeric(15,2) NOT NULL CHECK (gross_allocated >= 0),
  fee_allocated   numeric(15,2) NOT NULL CHECK (fee_allocated >= 0),
  net_allocated   numeric(15,2) NOT NULL CHECK (net_allocated >= 0),
  UNIQUE (anticipation_id, installment_id),
  FOREIGN KEY (tenant_id, anticipation_id) REFERENCES receivable_anticipations (tenant_id, id),
  FOREIGN KEY (tenant_id, installment_id)  REFERENCES obligation_installments (tenant_id, id)
);
CREATE INDEX idx_antic_alloc_installment ON anticipation_allocations (tenant_id, installment_id);

CREATE TABLE settlement_events (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  financial_account_id uuid NOT NULL,
  acquirer_id          uuid,
  settlement_date      date NOT NULL,
  gross_amount         numeric(15,2) NOT NULL,
  total_fees_amount    numeric(15,2) NOT NULL DEFAULT 0.00,
  net_amount           numeric(15,2) NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, financial_account_id) REFERENCES financial_accounts (tenant_id, id),
  FOREIGN KEY (tenant_id, acquirer_id)          REFERENCES acquirers (tenant_id, id)
);
CREATE INDEX idx_settlement_date ON settlement_events (tenant_id, settlement_date);

CREATE TABLE settlement_allocations (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  settlement_event_id    uuid NOT NULL,
  installment_id         uuid NOT NULL,
  allocated_gross_amount numeric(15,2) NOT NULL CHECK (allocated_gross_amount >= 0),
  allocated_net_amount   numeric(15,2) NOT NULL CHECK (allocated_net_amount >= 0),
  CHECK (allocated_net_amount <= allocated_gross_amount),
  UNIQUE (settlement_event_id, installment_id),
  FOREIGN KEY (tenant_id, settlement_event_id) REFERENCES settlement_events (tenant_id, id),
  FOREIGN KEY (tenant_id, installment_id)      REFERENCES obligation_installments (tenant_id, id)
);
CREATE INDEX idx_settle_alloc_installment ON settlement_allocations (tenant_id, installment_id);

CREATE TABLE settlement_fee_items (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  settlement_event_id uuid NOT NULL,
  fee_type            varchar(30) NOT NULL CHECK (fee_type IN ('MDR','ANTICIPATION_FEE','FIXED_FEE',
                      'TERMINAL_RENTAL','CHARGEBACK','ADJUSTMENT')),
  amount              numeric(15,2) NOT NULL,
  CHECK (fee_type = 'ADJUSTMENT' OR amount >= 0),  -- ajuste de centavos pode ter qualquer sinal
  FOREIGN KEY (tenant_id, settlement_event_id) REFERENCES settlement_events (tenant_id, id)
);
CREATE INDEX idx_fee_items_event ON settlement_fee_items (tenant_id, settlement_event_id);

CREATE TABLE bank_transactions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  financial_account_id  uuid NOT NULL,
  batch_item_id         uuid,
  external_fitid        varchar(120),
  bank_posting_date     date NOT NULL,
  direction             varchar(10) NOT NULL CHECK (direction IN ('CREDIT','DEBIT')),
  amount                numeric(15,2) NOT NULL CHECK (amount > 0),
  description           varchar(300) NOT NULL,
  reconciliation_status varchar(30) NOT NULL DEFAULT 'UNRECONCILED'
    CHECK (reconciliation_status IN ('UNRECONCILED','SUGGESTED_MATCH','PARTIALLY_RECONCILED','RECONCILED','EXCEPTION')),
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, financial_account_id) REFERENCES financial_accounts (tenant_id, id),
  FOREIGN KEY (tenant_id, batch_item_id)        REFERENCES batch_items (tenant_id, id)
);
CREATE UNIQUE INDEX uq_bank_tx_fitid ON bank_transactions (tenant_id, financial_account_id, external_fitid)
  WHERE external_fitid IS NOT NULL;
CREATE UNIQUE INDEX uq_bank_tx_batch_item ON bank_transactions (batch_item_id) WHERE batch_item_id IS NOT NULL;
CREATE INDEX idx_bank_tx_posting ON bank_transactions (tenant_id, financial_account_id, bank_posting_date, reconciliation_status);

CREATE TABLE cash_transactions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  financial_account_id uuid NOT NULL,
  business_unit_id     uuid,
  transaction_date     date NOT NULL,
  direction            varchar(10) NOT NULL CHECK (direction IN ('INFLOW','OUTFLOW')),
  amount               numeric(15,2) NOT NULL CHECK (amount > 0),
  category_id          uuid,
  source_document_id   uuid,
  origin_type          varchar(30) NOT NULL CHECK (origin_type IN ('BPO_ENTRY','CLIENT_MASTER_ENTRY','CLIENT_EMPLOYEE_ENTRY','BATCH_IMPORT')),
  created_by_user_id   uuid NOT NULL REFERENCES users(id),
  review_status        varchar(30) NOT NULL DEFAULT 'SUBMITTED_PENDING_BPO'
    CHECK (review_status IN ('DRAFT','SUBMITTED_PENDING_BPO','UNDER_BPO_REVIEW','APPROVED_FOR_LEDGER',
           'RETURNED_FOR_CORRECTION','REJECTED','LOCKED_IN_CLOSING')),
  deleted_at           timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, financial_account_id) REFERENCES financial_accounts (tenant_id, id),
  FOREIGN KEY (tenant_id, business_unit_id)     REFERENCES business_units (tenant_id, id),
  FOREIGN KEY (tenant_id, category_id)          REFERENCES accounting_categories (tenant_id, id),
  FOREIGN KEY (tenant_id, source_document_id)   REFERENCES documents (tenant_id, id)
);
CREATE INDEX idx_cash_tx_date ON cash_transactions (tenant_id, financial_account_id, transaction_date);

CREATE TABLE internal_transfers (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  from_account_id    uuid NOT NULL,
  to_account_id      uuid NOT NULL,
  transfer_date      date NOT NULL,
  amount             numeric(15,2) NOT NULL,
  outflow_bank_tx_id uuid,
  inflow_bank_tx_id  uuid,
  CHECK (from_account_id <> to_account_id AND amount > 0),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, from_account_id)    REFERENCES financial_accounts (tenant_id, id),
  FOREIGN KEY (tenant_id, to_account_id)      REFERENCES financial_accounts (tenant_id, id),
  FOREIGN KEY (tenant_id, outflow_bank_tx_id) REFERENCES bank_transactions (tenant_id, id),
  FOREIGN KEY (tenant_id, inflow_bank_tx_id)  REFERENCES bank_transactions (tenant_id, id)
);
CREATE UNIQUE INDEX uq_transfer_outflow ON internal_transfers (outflow_bank_tx_id) WHERE outflow_bank_tx_id IS NOT NULL;
CREATE UNIQUE INDEX uq_transfer_inflow ON internal_transfers (inflow_bank_tx_id) WHERE inflow_bank_tx_id IS NOT NULL;
CREATE INDEX idx_transfer_date ON internal_transfers (tenant_id, transfer_date);

CREATE TABLE reconciliation_groups (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  match_method       varchar(30) NOT NULL CHECK (match_method IN ('DETERMINISTIC_ID','EXACT_RULE','MANUAL_BPO')),
  status             varchar(20) NOT NULL CHECK (status IN ('ACTIVE','REVERSED')),
  notes              text,
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

CREATE TABLE reconciliation_allocations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  group_id          uuid NOT NULL,
  left_entity_type  varchar(40) NOT NULL CHECK (left_entity_type IN ('BANK_TRANSACTION','CASH_TRANSACTION')),
  left_entity_id    uuid NOT NULL,
  right_entity_type varchar(40) NOT NULL CHECK (right_entity_type IN ('SETTLEMENT_EVENT','OBLIGATION_INSTALLMENT','INTERNAL_TRANSFER')),
  right_entity_id   uuid NOT NULL,
  allocated_amount  numeric(15,2) NOT NULL CHECK (allocated_amount > 0),
  FOREIGN KEY (tenant_id, group_id) REFERENCES reconciliation_groups (tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX idx_recon_left  ON reconciliation_allocations (tenant_id, left_entity_type, left_entity_id);
CREATE INDEX idx_recon_right ON reconciliation_allocations (tenant_id, right_entity_type, right_entity_id);
CREATE INDEX idx_recon_group ON reconciliation_allocations (tenant_id, group_id);
