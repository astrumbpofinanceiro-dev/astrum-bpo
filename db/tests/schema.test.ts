import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./helpers.ts";

/** Transcrição das colunas do Documento 2 (§2–§6). */
const DOC2: Record<string, string> = {
  tenants: "id legal_name trade_name tax_id segment_code status created_at updated_at",
  users: "id email full_name is_bpo_master is_active created_at",
  bpo_staff_assignments: "id user_id tenant_id bpo_role assigned_at revoked_at",
  tenant_memberships: "id tenant_id user_id client_role is_blind_mode is_active created_at",
  user_scopes: "id tenant_id membership_id business_unit_id financial_account_id can_upload_documents can_create_manual_entries allowed_entry_types max_entry_amount can_view_reports can_view_bank_balances created_at",
  business_units: "id tenant_id name code is_active created_at",
  client_settings: "id tenant_id setting_key setting_value effective_from effective_to version updated_by_user_id created_at",
  client_routines: "id tenant_id business_unit_id title frequency expected_source_type due_day_offset is_active",
  routine_items: "id tenant_id routine_id competence_date due_date status linked_document_id completed_at",
  financial_accounts: "id tenant_id business_unit_id name account_type bank_code currency_code initial_balance initial_balance_date is_active",
  acquirers: "id tenant_id name settlement_account_id",
  payment_terminals: "id tenant_id acquirer_id business_unit_id terminal_code is_active",
  accounting_categories: "id tenant_id parent_id code name nature is_active",
  cost_centers: "id tenant_id name is_active",
  tags: "id tenant_id name color is_active",
  documents: "id tenant_id business_unit_id uploaded_by_user_id origin_channel doc_category competence_date period_start period_end receipt_status processing_status review_status created_at",
  document_files: "id tenant_id document_id file_role storage_bucket storage_key original_filename mime_type file_size_bytes sha256_hash created_at",
  import_batches: "id tenant_id document_id source_type idempotency_key parser_version period_start period_end status total_items imported_items duplicate_items created_at",
  batch_items: "id tenant_id batch_id row_number external_item_id dedup_fingerprint raw_payload item_status target_entity_type target_entity_id",
  economic_operations: "id tenant_id business_unit_id operation_type origin_type created_by_user_id source_document_id acquirer_id external_nsu_tid category_id cost_center_id operation_date competence_date gross_amount currency_code description review_status is_locked created_at",
  financial_obligations: "id tenant_id economic_operation_id direction counterparty_name total_amount status created_at",
  obligation_installments: "id tenant_id obligation_id installment_number total_installments gross_amount expected_fee_amount net_expected_amount settled_amount due_date original_expected_settlement_date current_expected_settlement_date status",
  receivable_anticipations: "id tenant_id acquirer_id requested_at effective_date gross_anticipated_amount anticipation_fee_amount net_anticipated_amount source_document_id created_at",
  anticipation_allocations: "id tenant_id anticipation_id installment_id gross_allocated fee_allocated net_allocated",
  settlement_events: "id tenant_id financial_account_id acquirer_id settlement_date gross_amount total_fees_amount net_amount created_at",
  settlement_allocations: "id tenant_id settlement_event_id installment_id allocated_gross_amount allocated_net_amount",
  settlement_fee_items: "id tenant_id settlement_event_id fee_type amount",
  bank_transactions: "id tenant_id financial_account_id batch_item_id external_fitid bank_posting_date direction amount description reconciliation_status created_at",
  cash_transactions: "id tenant_id financial_account_id business_unit_id transaction_date direction amount category_id source_document_id origin_type created_by_user_id review_status",
  internal_transfers: "id tenant_id from_account_id to_account_id transfer_date amount outflow_bank_tx_id inflow_bank_tx_id",
  reconciliation_groups: "id tenant_id match_method status notes created_by_user_id created_at",
  reconciliation_allocations: "id tenant_id group_id left_entity_type left_entity_id right_entity_type right_entity_id allocated_amount",
  blocking_issues: "id tenant_id competence_date target_entity_type target_entity_id severity status title description assigned_to_side due_date opened_by_user_id client_response_text responded_by_user_id responded_by_role responded_at resolved_by_user_id resolved_at created_at",
  period_closings: "id tenant_id competence_date status current_version_number",
  closing_versions: "id tenant_id period_closing_id version_number closing_type status caveat_justification caveat_review_deadline snapshot_summary approved_by_user_id second_approver_user_id published_at",
  audit_logs: "id tenant_id actor_user_id actor_effective_role is_bpo_master_impersonation impersonation_reason entity_type entity_id action old_values new_values reason created_at",
};

describe("cobertura do Documento 2", () => {
  let db: TestDb;
  beforeAll(async () => { db = await createTestDb(); });
  afterAll(async () => { await db.close(); });

  const q = async <T extends object>(sql: string) => (await db.admin.query<T>(sql)).rows;

  it("tem as 36 tabelas e todas as colunas especificadas", async () => {
    const rows = await q<{ table_name: string; column_name: string }>(
      "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema='public'");
    const have = new Set(rows.map((r) => `${r.table_name}.${r.column_name}`));
    const missing = Object.entries(DOC2).flatMap(([t, cols]) =>
      cols.split(" ").map((c) => `${t}.${c}`).filter((k) => !have.has(k)));
    expect(Object.keys(DOC2)).toHaveLength(36);
    expect(missing).toEqual([]);
    const extraTables = [...new Set(rows.map((r) => r.table_name))].filter((t) => !(t in DOC2)).sort();
    expect(extraTables).toEqual(["ai_processing_logs", "approval_records", "closing_version_issues", "installment_charges"]);
  });

  it("não usa ponto flutuante e usa NUMERIC(15,2) em todo valor monetário", async () => {
    const floats = await q("SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND data_type IN ('real','double precision','money')");
    expect(floats).toEqual([]);
    const other = await q<{ c: string }>(`SELECT table_name||'.'||column_name AS c FROM information_schema.columns
      WHERE table_schema='public' AND data_type='numeric' AND NOT (numeric_precision=15 AND numeric_scale=2)`);
    expect(other.map((r) => r.c)).toEqual(["ai_processing_logs.estimated_cost"]);
  });

  it("não tem ON DELETE CASCADE", async () => {
    expect(await q("SELECT conname FROM pg_constraint WHERE contype='f' AND confdeltype IN ('c','n','d')")).toEqual([]);
  });

  it("tem RLS habilitado e forçado em toda tabela com tenant_id (e em tenants)", async () => {
    const unprotected = await q(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind='r'
        AND (c.relname='tenants' OR EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='tenant_id'))
        AND NOT (c.relrowsecurity AND c.relforcerowsecurity)`);
    expect(unprotected).toEqual([]);
  });
});
