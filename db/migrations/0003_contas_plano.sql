-- 0003 — Domínio B: contas, adquirentes e plano de contas (Doc 2 §3) + user_scopes (§2.5)
CREATE TABLE financial_accounts (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  business_unit_id     uuid,
  name                 varchar(120) NOT NULL,
  account_type         varchar(30) NOT NULL CHECK (account_type IN ('BANK_CHECKING','CASH_PHYSICAL','CORPORATE_CARD')),
  bank_code            varchar(10),
  currency_code        char(3) NOT NULL DEFAULT 'BRL',
  initial_balance      numeric(15,2) NOT NULL DEFAULT 0.00,
  initial_balance_date date NOT NULL,
  is_active            boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, business_unit_id) REFERENCES business_units (tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE user_scopes (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                 uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  membership_id             uuid NOT NULL,
  business_unit_id          uuid,
  financial_account_id      uuid,
  can_upload_documents      boolean NOT NULL DEFAULT true,
  can_create_manual_entries boolean NOT NULL DEFAULT false,
  allowed_entry_types       varchar(50)[] NOT NULL DEFAULT '{}',
  max_entry_amount          numeric(15,2) CHECK (max_entry_amount >= 0),
  can_view_reports          boolean NOT NULL DEFAULT false,
  can_view_bank_balances    boolean NOT NULL DEFAULT false,
  created_at                timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, membership_id) REFERENCES tenant_memberships (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, business_unit_id) REFERENCES business_units (tenant_id, id),
  FOREIGN KEY (tenant_id, financial_account_id) REFERENCES financial_accounts (tenant_id, id)
);
CREATE INDEX idx_user_scopes_membership ON user_scopes (tenant_id, membership_id);

CREATE TABLE acquirers (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  name                  varchar(80) NOT NULL,
  settlement_account_id uuid NOT NULL,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, settlement_account_id) REFERENCES financial_accounts (tenant_id, id)
);

CREATE TABLE payment_terminals (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  acquirer_id      uuid NOT NULL,
  business_unit_id uuid,
  terminal_code    varchar(60) NOT NULL,
  is_active        boolean NOT NULL DEFAULT true,
  FOREIGN KEY (tenant_id, acquirer_id) REFERENCES acquirers (tenant_id, id),
  FOREIGN KEY (tenant_id, business_unit_id) REFERENCES business_units (tenant_id, id)
);

CREATE TABLE accounting_categories (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  parent_id uuid,
  code      varchar(30) NOT NULL,
  name      varchar(120) NOT NULL,
  nature    varchar(30) NOT NULL CHECK (nature IN ('REVENUE','DIRECT_COST','FIXED_EXPENSE',
            'VARIABLE_EXPENSE','FINANCIAL_EXPENSE','PARTNER_DRAW','CAPITAL_CONTRIBUTION')),
  is_active boolean NOT NULL DEFAULT true,
  CHECK (parent_id IS DISTINCT FROM id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, parent_id) REFERENCES accounting_categories (tenant_id, id)
);

CREATE TABLE cost_centers (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  name      varchar(100) NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, id)
);

CREATE TABLE tags (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  name      varchar(60) NOT NULL,
  color     varchar(15)
);
CREATE INDEX idx_tags_tenant ON tags (tenant_id);
