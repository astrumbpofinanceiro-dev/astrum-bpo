-- 0004 — Domínio C: documentos, lotes e triagem (Doc 2 §4; estados Doc 1 §2.1–2.2)
CREATE TABLE documents (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  business_unit_id    uuid,
  uploaded_by_user_id uuid NOT NULL REFERENCES users(id),
  origin_channel      varchar(30) NOT NULL CHECK (origin_channel IN ('WEB_PORTAL','MOBILE_UPLOAD','BPO_UPLOAD')),
  doc_category        varchar(40) NOT NULL CHECK (doc_category IN ('BANK_STATEMENT','ACQUIRER_REPORT',
                      'INVOICE_NFE','BOLETO','RECEIPT','CASH_SUMMARY','OTHER')),
  competence_date     date,
  period_start        date,
  period_end          date,
  receipt_status      varchar(30) NOT NULL DEFAULT 'RECEIVED'
    CHECK (receipt_status IN ('AWAITING_UPLOAD','RECEIVED','REJECTED_INVALID','SUPERSEDED')),
  processing_status   varchar(30) NOT NULL DEFAULT 'NOT_STARTED'
    CHECK (processing_status IN ('NOT_STARTED','QUEUED','PROCESSING','PROCESSED_OK',
           'PROCESSED_WITH_WARNINGS','FAILED_PROCESSING')),
  review_status       varchar(30) NOT NULL DEFAULT 'UNREVIEWED'
    CHECK (review_status IN ('UNREVIEWED','IN_REVIEW','APPROVED','REJECTED','NEEDS_INFO','ARCHIVED')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz,
  CHECK (period_end IS NULL OR period_start IS NULL OR period_end >= period_start),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, business_unit_id) REFERENCES business_units (tenant_id, id)
);
CREATE INDEX idx_documents_tenant_comp ON documents (tenant_id, competence_date, review_status);

ALTER TABLE routine_items ADD FOREIGN KEY (tenant_id, linked_document_id)
  REFERENCES documents (tenant_id, id) ON DELETE RESTRICT;

CREATE TABLE document_files (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  document_id       uuid NOT NULL,
  file_role         varchar(20) NOT NULL CHECK (file_role IN ('ORIGINAL','NORMALIZED_ARTIFACT')),
  storage_bucket    varchar(100) NOT NULL,
  storage_key       varchar(500) NOT NULL,
  original_filename varchar(255) NOT NULL,
  mime_type         varchar(100) NOT NULL,
  file_size_bytes   bigint NOT NULL CHECK (file_size_bytes >= 0),
  sha256_hash       char(64) NOT NULL CHECK (sha256_hash ~ '^[0-9a-f]{64}$'),
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (storage_bucket, storage_key),
  FOREIGN KEY (tenant_id, document_id) REFERENCES documents (tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX idx_doc_files_hash ON document_files (tenant_id, sha256_hash);
CREATE UNIQUE INDEX uq_doc_files_original ON document_files (document_id) WHERE file_role = 'ORIGINAL';

-- Estados: união das listas do Doc 1 §2.2 e Doc 2 §4.3 (ver docs/decisoes-pendentes.md).
CREATE TABLE import_batches (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  document_id     uuid NOT NULL,
  source_type     varchar(30) NOT NULL CHECK (source_type IN ('BANK_OFX_CSV','ACQUIRER_CSV_XLSX','PDV_SUMMARY')),
  idempotency_key varchar(128) NOT NULL,
  parser_version  varchar(30) NOT NULL,
  period_start    date,
  period_end      date,
  status          varchar(30) NOT NULL CHECK (status IN ('UPLOADED','VALIDATING','DUPLICATE_FILE',
                  'OVERLAP_REVIEW','READY_TO_IMPORT','IMPORTING','IMPORTED_COMPLETE',
                  'IMPORTED_WITH_EXCEPTIONS','FAILED_IMPORT','REJECTED','PARTIALLY_IMPORTED')),
  total_items     integer NOT NULL DEFAULT 0 CHECK (total_items >= 0),
  imported_items  integer NOT NULL DEFAULT 0 CHECK (imported_items >= 0),
  duplicate_items integer NOT NULL DEFAULT 0 CHECK (duplicate_items >= 0),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, document_id) REFERENCES documents (tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE batch_items (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  batch_id           uuid NOT NULL,
  row_number         integer NOT NULL,
  external_item_id   varchar(120),
  dedup_fingerprint  char(64) NOT NULL,
  raw_payload        jsonb NOT NULL,
  item_status        varchar(30) NOT NULL CHECK (item_status IN ('PENDING','NEW_VALID','DUPLICATE_ITEM',
                     'AMBIGUOUS_OVERLAP','INVALID_ITEM','COMMITTED','IGNORED','IGNORED_DUPLICATE','REJECTED')),
  target_entity_type varchar(40),
  target_entity_id   uuid,
  UNIQUE (batch_id, row_number),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, batch_id) REFERENCES import_batches (tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX idx_batch_items_ext ON batch_items (tenant_id, external_item_id) WHERE external_item_id IS NOT NULL;
-- Idempotência: o mesmo item só pode ser efetivado uma vez (Doc 3 §1).
CREATE UNIQUE INDEX uq_batch_items_committed ON batch_items (tenant_id, dedup_fingerprint)
  WHERE item_status = 'COMMITTED';
