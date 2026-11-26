-- 0002 — Domínio A: identidade, multi-tenant, escopos e rotina (Doc 2 §2)
-- Padrão: UNIQUE (tenant_id, id) em toda tabela referenciada, para que as FKs
-- sejam compostas e uma linha nunca aponte para registro de outro tenant
-- (a verificação de FK do PostgreSQL ignora RLS).

CREATE TABLE tenants (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_name   varchar(200) NOT NULL,
  trade_name   varchar(200) NOT NULL,
  tax_id       varchar(20)  NOT NULL UNIQUE,
  segment_code varchar(50)  NOT NULL,
  status       varchar(30)  NOT NULL DEFAULT 'ACTIVE'
               CHECK (status IN ('ONBOARDING','ACTIVE','SUSPENDED','CLOSED')),
  created_at   timestamptz  NOT NULL DEFAULT now(),
  updated_at   timestamptz  NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         varchar(255) NOT NULL UNIQUE,
  full_name     varchar(150) NOT NULL,
  is_bpo_master boolean      NOT NULL DEFAULT false,
  is_active     boolean      NOT NULL DEFAULT true,
  created_at    timestamptz  NOT NULL DEFAULT now()
);

-- A flag de sessão só vale se o usuário realmente for Master ativo no banco.
CREATE FUNCTION app.is_bpo_master() RETURNS boolean LANGUAGE sql STABLE AS
$$ SELECT COALESCE(app.setting('app.is_bpo_master') = 'true', false)
      AND EXISTS (SELECT 1 FROM public.users u
                  WHERE u.id = app.current_user_id() AND u.is_bpo_master AND u.is_active) $$;

CREATE TABLE bpo_staff_assignments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  bpo_role    varchar(30) NOT NULL CHECK (bpo_role IN ('BPO_ANALYST','BPO_REVIEWER','BPO_AUDITOR')),
  assigned_at timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz
);
CREATE UNIQUE INDEX uq_bpo_assignment_active
  ON bpo_staff_assignments (user_id, tenant_id, bpo_role) WHERE revoked_at IS NULL;

CREATE TABLE tenant_memberships (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  client_role   varchar(30) NOT NULL CHECK (client_role IN ('CLIENT_MASTER','CLIENT_EMPLOYEE')),
  is_blind_mode boolean NOT NULL DEFAULT true,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id),
  UNIQUE (tenant_id, id)
);

CREATE TABLE business_units (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  name       varchar(120) NOT NULL,
  code       varchar(30),
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

-- user_scopes é criada em 0003 (depende de financial_accounts).

CREATE TABLE client_settings (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  setting_key        varchar(80) NOT NULL,
  setting_value      jsonb NOT NULL,
  effective_from     date NOT NULL,
  effective_to       date,
  version            integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_by_user_id uuid NOT NULL REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to >= effective_from),
  UNIQUE (tenant_id, setting_key, version)
);
CREATE INDEX idx_client_settings_lookup ON client_settings (tenant_id, setting_key, effective_from);

CREATE TABLE client_routines (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  business_unit_id     uuid,
  title                varchar(150) NOT NULL,
  frequency            varchar(20) NOT NULL CHECK (frequency IN ('DAILY','WEEKLY','BIWEEKLY','MONTHLY')),
  expected_source_type varchar(40) NOT NULL
    CHECK (expected_source_type IN ('BANK_STATEMENT','ACQUIRER_REPORT','CASH_SUMMARY','EXPENSE_RECEIPTS')),
  due_day_offset       integer NOT NULL DEFAULT 1,
  is_active            boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, business_unit_id) REFERENCES business_units (tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE routine_items (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  routine_id         uuid NOT NULL,
  competence_date    date NOT NULL,
  due_date           date NOT NULL,
  status             varchar(30) NOT NULL CHECK (status IN ('PENDING','SUBMITTED','COMPLETED','OVERDUE','WAIVED')),
  linked_document_id uuid,
  completed_at       timestamptz,
  FOREIGN KEY (tenant_id, routine_id) REFERENCES client_routines (tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX idx_routine_items_due ON routine_items (tenant_id, competence_date, status, due_date);
