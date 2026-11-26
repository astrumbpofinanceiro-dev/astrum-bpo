/**
 * Lançamento manual (Doc 1 §2.3). Nesta etapa todo lançamento é um registro de caixa
 * físico; competência e classificação são definidas pelo BPO no motor financeiro.
 */
import type pg from "pg";
import { Decimal } from "decimal.js";
import { z } from "zod";
import { businessDate } from "../../shared/dates/business-date";
import { conflict, forbidden, invalid } from "../../shared/errors";
import { assertCan, can, type Access } from "../identity-access/authorize";
import { openSystemIssue } from "../issues-approvals/issues";
import { resolveSetting, today } from "../tenants-config/settings";

export const ENTRY_TYPES = {
  CASH_EXPENSE: "OUTFLOW", DAILY_SALES_SUMMARY: "INFLOW", DECLARED_PAYMENT: "OUTFLOW", DECLARED_RECEIPT: "INFLOW",
} as const;
type EntryType = keyof typeof ENTRY_TYPES;

const date = z.string().refine((v) => { try { businessDate(v); return true; } catch { return false; } });

const fields = {
  financialAccountId: z.guid(),
  businessUnitId: z.guid().optional(),
  date,
  amount: z.string().regex(/^\d{1,13}(\.\d{1,2})?$/).refine((v) => Number(v) > 0),
  description: z.string().trim().min(3).max(300),
  documentId: z.guid().optional(),
  missingReceiptJustification: z.string().trim().min(10).max(1000).optional(),
};
export const entryInput = z.strictObject({
  entryType: z.enum(Object.keys(ENTRY_TYPES) as [EntryType, ...EntryType[]]),
  ...fields,
  asDraft: z.boolean().default(false),
});
export const entryPatch = z.strictObject(fields).partial();

interface Entry {
  entryType: EntryType; financialAccountId: string; businessUnitId: string | null; date: string; amount: string;
  description: string; documentId: string | null; missingReceiptJustification: string | null;
}

/** Valida escopo, referências e a regra de comprovante. */
async function check(c: pg.PoolClient, access: Access, permission: "entries.create", e: Entry) {
  const account = (await c.query(
    "SELECT business_unit_id, account_type, is_active FROM financial_accounts WHERE tenant_id = $1 AND id = $2",
    [access.tenantId, e.financialAccountId])).rows[0];
  const unit = e.businessUnitId ?? account?.business_unit_id ?? null;
  const role = assertCan(access, permission, {
    businessUnitId: unit, financialAccountId: e.financialAccountId, entryType: e.entryType, amount: e.amount,
  });
  if (!account?.is_active) throw invalid("INVALID_REFERENCE");
  // Movimento declarado em conta bancária duplicaria o extrato.
  if (account.account_type !== "CASH_PHYSICAL") throw invalid("CASH_ACCOUNT_REQUIRED");
  if (account.business_unit_id && unit !== account.business_unit_id) throw invalid("INVALID_REFERENCE");
  if (role.startsWith("CLIENT_") &&
      (await resolveSetting(c, access.tenantId, "CLIENT_MANUAL_ENTRY_ENABLED", today())) === false) throw forbidden();
  if (e.documentId) {
    const document = (await c.query(
      "SELECT uploaded_by_user_id FROM documents WHERE tenant_id = $1 AND id = $2 AND receipt_status = 'RECEIVED'",
      [access.tenantId, e.documentId])).rows[0];
    if (!document || !can(access, "documents.view", { ownerUserId: document.uploaded_by_user_id })) {
      throw invalid("INVALID_REFERENCE");
    }
  }
  return { role, unit };
}

async function missingReceipt(c: pg.PoolClient, tenantId: string, e: Entry): Promise<boolean> {
  if (e.documentId || ENTRY_TYPES[e.entryType] !== "OUTFLOW") return false;
  const limit = await resolveSetting(c, tenantId, "MANUAL_RECEIPT_THRESHOLD", e.date);
  return limit !== null && new Decimal(e.amount).greaterThan(limit);
}

/** Ao enviar para o BPO: exige justificativa e abre a pendência (Doc 1, Exceção 6). */
async function onSubmit(c: pg.PoolClient, access: Access, id: string, e: Entry) {
  if (!(await missingReceipt(c, access.tenantId, e))) return;
  if (!e.missingReceiptJustification) throw invalid("RECEIPT_OR_JUSTIFICATION_REQUIRED");
  const open = await c.query(
    "SELECT 1 FROM blocking_issues WHERE tenant_id = $1 AND target_entity_id = $2 AND status <> 'RESOLVED'", [access.tenantId, id]);
  if (open.rowCount) return;
  await openSystemIssue(c, access.tenantId, access.userId, {
    competenceDate: e.date, targetType: "CASH_TRANSACTION", targetId: id,
    severity: (await resolveSetting(c, access.tenantId, "MANUAL_RECEIPT_SEVERITY", e.date)) ?? "WARNING",
    title: "Lançamento sem comprovante acima do limite", description: e.missingReceiptJustification,
  });
}

export async function createEntry(c: pg.PoolClient, access: Access, raw: unknown) {
  const input = entryInput.parse(raw);
  const e: Entry = { ...input, businessUnitId: input.businessUnitId ?? null, documentId: input.documentId ?? null,
    missingReceiptJustification: input.missingReceiptJustification ?? null };
  const { role, unit } = await check(c, access, "entries.create", e);
  const origin = role === "CLIENT_MASTER" ? "CLIENT_MASTER_ENTRY"
    : role === "CLIENT_EMPLOYEE" ? "CLIENT_EMPLOYEE_ENTRY" : "BPO_ENTRY";
  const status = input.asDraft ? "DRAFT" : "SUBMITTED_PENDING_BPO";
  const { rows } = await c.query(
    `INSERT INTO cash_transactions (tenant_id, financial_account_id, business_unit_id, transaction_date, direction,
        amount, source_document_id, origin_type, created_by_user_id, review_status, entry_type, description,
        missing_receipt_justification)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
    [access.tenantId, e.financialAccountId, unit, e.date, ENTRY_TYPES[e.entryType], e.amount, e.documentId,
     origin, access.userId, status, e.entryType, e.description, e.missingReceiptJustification]);
  if (!input.asDraft) await onSubmit(c, access, rows[0].id, e);
  return { id: rows[0].id, reviewStatus: status };
}

async function load(c: pg.PoolClient, access: Access, id: string) {
  const row = (await c.query(
    `SELECT * FROM cash_transactions WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL FOR NO KEY UPDATE`,
    [access.tenantId, id])).rows[0];
  if (!row) throw forbidden();
  const entry: Entry = {
    entryType: row.entry_type, financialAccountId: row.financial_account_id, businessUnitId: row.business_unit_id,
    date: row.transaction_date, amount: row.amount, description: row.description, documentId: row.source_document_id,
    missingReceiptJustification: row.missing_receipt_justification,
  };
  return { row, entry };
}

function assertEditable(access: Access, row: Record<string, string>) {
  assertCan(access, "entries.edit", {
    businessUnitId: row.business_unit_id, financialAccountId: row.financial_account_id,
    ownerUserId: row.created_by_user_id, status: row.review_status,
  });
  // Equipe BPO e Master Cliente também não alteram o que já está em conferência ou recusado.
  if (["UNDER_BPO_REVIEW", "REJECTED"].includes(row.review_status!)) throw conflict("INVALID_TRANSITION");
}

export async function updateEntry(c: pg.PoolClient, access: Access, id: string, raw: unknown) {
  const patch = entryPatch.parse(raw);
  const { row, entry } = await load(c, access, id);
  assertEditable(access, row);
  const e: Entry = { ...entry, ...patch };
  const { unit } = await check(c, access, "entries.create", e); // os limites valem também na edição
  await c.query(
    `UPDATE cash_transactions SET financial_account_id = $3, business_unit_id = $4, transaction_date = $5, amount = $6,
        description = $7, source_document_id = $8, missing_receipt_justification = $9
      WHERE tenant_id = $1 AND id = $2`,
    [access.tenantId, id, e.financialAccountId, unit, e.date, e.amount, e.description, e.documentId,
     e.missingReceiptJustification]);
  if (row.review_status === "SUBMITTED_PENDING_BPO") await onSubmit(c, access, id, e);
  return { id, reviewStatus: row.review_status };
}

/** Exclusão lógica; só rascunho ou devolvido. */
export async function deleteEntry(c: pg.PoolClient, access: Access, id: string) {
  const { row } = await load(c, access, id);
  assertEditable(access, row);
  if (!["DRAFT", "RETURNED_FOR_CORRECTION"].includes(row.review_status)) throw conflict("INVALID_TRANSITION");
  await c.query("UPDATE cash_transactions SET deleted_at = now() WHERE tenant_id = $1 AND id = $2", [access.tenantId, id]);
}

export async function submitEntry(c: pg.PoolClient, access: Access, id: string) {
  const { row, entry } = await load(c, access, id);
  assertEditable(access, row);
  if (!["DRAFT", "RETURNED_FOR_CORRECTION"].includes(row.review_status)) throw conflict("INVALID_TRANSITION");
  await check(c, access, "entries.create", entry);
  await c.query("UPDATE cash_transactions SET review_status = 'SUBMITTED_PENDING_BPO' WHERE tenant_id = $1 AND id = $2",
    [access.tenantId, id]);
  await onSubmit(c, access, id, entry);
  return { id, reviewStatus: "SUBMITTED_PENDING_BPO" };
}

export const REVIEW_ACTIONS = {
  START: { from: "SUBMITTED_PENDING_BPO", to: "UNDER_BPO_REVIEW", permission: "processing.operate", note: false },
  APPROVE: { from: "UNDER_BPO_REVIEW", to: "APPROVED_FOR_LEDGER", permission: "entries.approve", note: false },
  RETURN: { from: "UNDER_BPO_REVIEW", to: "RETURNED_FOR_CORRECTION", permission: "entries.approve", note: true },
  REJECT: { from: "UNDER_BPO_REVIEW", to: "REJECTED", permission: "entries.approve", note: true },
} as const;

export async function reviewEntry(
  c: pg.PoolClient, access: Access, id: string, action: keyof typeof REVIEW_ACTIONS, note?: string,
) {
  const rule = REVIEW_ACTIONS[action];
  if (rule.note && !note) throw invalid("NOTE_REQUIRED");
  await load(c, access, id);
  const { rowCount } = await c.query(
    `UPDATE cash_transactions SET review_status = $3, review_note = COALESCE($4, review_note)
      WHERE tenant_id = $1 AND id = $2 AND review_status = $5`, [access.tenantId, id, rule.to, note ?? null, rule.from]);
  if (!rowCount) throw conflict("INVALID_TRANSITION");
  return { id, reviewStatus: rule.to };
}
