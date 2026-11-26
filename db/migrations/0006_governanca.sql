-- 0006 — Domínio E: pendências, fechamento versionado e auditoria (Doc 2 §6)
CREATE TABLE blocking_issues (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  competence_date      date NOT NULL,
  target_entity_type   varchar(40) NOT NULL CHECK (target_entity_type IN ('DOCUMENT','BATCH','OPERATION',
                       'INSTALLMENT','BANK_TRANSACTION','PERIOD_CLOSING')),
  target_entity_id     uuid NOT NULL,
  severity             varchar(30) NOT NULL CHECK (severity IN ('INFO','WARNING','BLOCKING_OPERATIONAL','CRITICAL')),
  status               varchar(40) NOT NULL CHECK (status IN ('OPEN','WAITING_CLIENT_RESPONSE','WAITING_BPO_ACTION',
                       'ANSWERED_PENDING_BPO_VALIDATION','RESOLVED','ACCEPTED_WITH_CAVEAT','REOPENED')),
  title                varchar(200) NOT NULL,
  description          text NOT NULL,
  assigned_to_side     varchar(20) NOT NULL CHECK (assigned_to_side IN ('CLIENT','BPO')),
  due_date             date,
  opened_by_user_id    uuid NOT NULL REFERENCES users(id),
  client_response_text text,
  responded_by_user_id uuid REFERENCES users(id),
  responded_by_role    varchar(30),
  responded_at         timestamptz,
  resolved_by_user_id  uuid REFERENCES users(id),
  resolved_at          timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  -- Doc 1 §2.6: ressalva somente para bloqueio operacional (nunca CRITICAL).
  CHECK (status <> 'ACCEPTED_WITH_CAVEAT' OR severity = 'BLOCKING_OPERATIONAL'),
  UNIQUE (tenant_id, id)
);
CREATE INDEX idx_issues_open ON blocking_issues (tenant_id, competence_date, severity, status);
CREATE INDEX idx_issues_target ON blocking_issues (tenant_id, target_entity_type, target_entity_id);

CREATE TABLE period_closings (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  competence_date        date NOT NULL CHECK (EXTRACT(day FROM competence_date) = 1),
  status                 varchar(30) NOT NULL CHECK (status IN ('NOT_STARTED','IN_COLLECTION','IN_PROCESSING',
    'BLOCKED_BY_ISSUES','READY_FOR_REVIEW','CLOSED_PUBLISHED','CLOSED_WITH_CAVEATS','REOPENED')),
  current_version_number integer NOT NULL DEFAULT 0 CHECK (current_version_number >= 0),
  UNIQUE (tenant_id, competence_date),
  UNIQUE (tenant_id, id)
);

CREATE TABLE closing_versions (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  period_closing_id       uuid NOT NULL,
  version_number          integer NOT NULL CHECK (version_number >= 1),
  closing_type            varchar(30) NOT NULL CHECK (closing_type IN ('PUBLISHED_FULL','PUBLISHED_WITH_CAVEATS')),
  status                  varchar(20) NOT NULL CHECK (status IN ('ACTIVE','SUPERSEDED')),
  caveat_justification    text,
  caveat_review_deadline  date,
  snapshot_summary        jsonb NOT NULL,
  approved_by_user_id     uuid NOT NULL REFERENCES users(id),
  second_approver_user_id uuid REFERENCES users(id),
  published_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (period_closing_id, version_number),
  UNIQUE (tenant_id, id),
  CHECK (closing_type <> 'PUBLISHED_WITH_CAVEATS' OR
         (caveat_justification IS NOT NULL AND char_length(btrim(caveat_justification)) >= 20
          AND caveat_review_deadline IS NOT NULL)),
  CHECK (second_approver_user_id IS NULL OR second_approver_user_id <> approved_by_user_id),
  FOREIGN KEY (tenant_id, period_closing_id) REFERENCES period_closings (tenant_id, id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX uq_closing_version_active ON closing_versions (period_closing_id) WHERE status = 'ACTIVE';

CREATE TABLE audit_logs (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                   uuid REFERENCES tenants(id),
  actor_user_id               uuid NOT NULL REFERENCES users(id),
  actor_effective_role        varchar(30) NOT NULL,
  is_bpo_master_impersonation boolean NOT NULL DEFAULT false,
  impersonation_reason        text,
  entity_type                 varchar(50) NOT NULL,
  entity_id                   uuid NOT NULL,
  action                      varchar(50) NOT NULL,
  old_values                  jsonb,
  new_values                  jsonb,
  reason                      text,
  created_at                  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_tenant_entity ON audit_logs (tenant_id, entity_type, entity_id, created_at DESC);
