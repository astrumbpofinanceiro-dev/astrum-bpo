/** Pendências (Doc 1 §2.6; v3.1 §12). Ressalva e reabertura entram na Etapa 5. */
import type pg from "pg";
import { z } from "zod";
import { businessDate, firstDayOfMonth } from "../../shared/dates/business-date";
import { conflict, forbidden, invalid } from "../../shared/errors";
import { assertCan, can, type Access } from "../identity-access/authorize";
import { today } from "../tenants-config/settings";

const TARGETS = {
  DOCUMENT: "documents", BATCH: "import_batches", OPERATION: "economic_operations",
  INSTALLMENT: "obligation_installments", BANK_TRANSACTION: "bank_transactions",
  CASH_TRANSACTION: "cash_transactions", PERIOD_CLOSING: "period_closings",
} as const;
type Target = keyof typeof TARGETS;

const date = z.string().refine((v) => { try { businessDate(v); return true; } catch { return false; } });

export const issueInput = z.strictObject({
  competenceDate: date,
  targetType: z.enum(Object.keys(TARGETS) as [Target, ...Target[]]),
  targetId: z.guid(),
  severity: z.enum(["INFO", "WARNING", "BLOCKING_OPERATIONAL", "CRITICAL"]),
  title: z.string().trim().min(3).max(200),
  description: z.string().trim().min(3).max(4000),
  assignedToSide: z.enum(["CLIENT", "BPO"]),
  assignedToUserId: z.guid().optional(),
  dueDate: date.optional(),
});

type NewIssue = z.output<typeof issueInput>;

async function create(c: pg.PoolClient, tenantId: string, openedBy: string, i: NewIssue): Promise<string> {
  const { rows } = await c.query(
    `INSERT INTO blocking_issues (tenant_id, competence_date, target_entity_type, target_entity_id, severity, status,
        title, description, assigned_to_side, assigned_to_user_id, due_date, opened_by_user_id)
     VALUES ($1,$2,$3,$4,$5,'OPEN',$6,$7,$8,$9,$10,$11) RETURNING id`,
    [tenantId, firstDayOfMonth(businessDate(i.competenceDate)), i.targetType, i.targetId, i.severity,
     i.title, i.description, i.assignedToSide, i.assignedToUserId ?? null, i.dueDate ?? null, openedBy]);
  await c.query("UPDATE blocking_issues SET status = $2 WHERE id = $1",
    [rows[0].id, i.assignedToSide === "CLIENT" ? "WAITING_CLIENT_RESPONSE" : "WAITING_BPO_ACTION"]);
  return rows[0].id;
}

/** Pendência aberta por regra do sistema; sempre começa do lado do BPO. */
export function openSystemIssue(c: pg.PoolClient, tenantId: string, openedBy: string, i:
  Pick<NewIssue, "targetType" | "targetId" | "severity" | "title" | "description"> & { competenceDate?: string }) {
  return create(c, tenantId, openedBy, { ...i, competenceDate: i.competenceDate ?? today(), assignedToSide: "BPO" });
}

export async function openIssue(c: pg.PoolClient, access: Access, raw: unknown) {
  const input = issueInput.parse(raw);
  const found = await c.query(`SELECT 1 FROM ${TARGETS[input.targetType]} WHERE tenant_id = $1 AND id = $2`,
    [access.tenantId, input.targetId]);
  if (!found.rowCount) throw invalid("INVALID_REFERENCE");
  if (input.assignedToUserId) {
    const table = input.assignedToSide === "CLIENT"
      ? "tenant_memberships WHERE tenant_id = $1 AND user_id = $2 AND is_active"
      : "bpo_staff_assignments WHERE tenant_id = $1 AND user_id = $2 AND revoked_at IS NULL";
    if (!(await c.query(`SELECT 1 FROM ${table}`, [access.tenantId, input.assignedToUserId])).rowCount) {
      throw invalid("INVALID_ASSIGNEE");
    }
  }
  return { id: await create(c, access.tenantId, access.userId, input) };
}

export async function listIssues(c: pg.PoolClient, access: Access, filter: { id?: string } = {}) {
  const { rows } = await c.query(
    `SELECT id, competence_date, target_entity_type, target_entity_id, severity, status, title, description,
            assigned_to_side, assigned_to_user_id, due_date, client_response_text, response_document_id,
            responded_at, resolved_at, created_at
       FROM blocking_issues WHERE tenant_id = $1 AND ($2::uuid IS NULL OR id = $2)
      ORDER BY created_at, id LIMIT 500`, [access.tenantId, filter.id ?? null]);
  return rows.filter((r) =>
    can(access, "issues.view", { assigneeUserId: r.assigned_to_user_id }) &&
    // Cliente não vê pendências internas do BPO.
    (!access.roles.some((role) => role.startsWith("CLIENT_")) || r.assigned_to_side === "CLIENT"));
}

export const responseInput = z.strictObject({
  text: z.string().trim().min(3).max(4000),
  documentId: z.guid().optional(),
});

/** Responder nunca encerra: vai para validação do BPO. */
export async function respondIssue(c: pg.PoolClient, access: Access, issueId: string, raw: unknown) {
  const input = responseInput.parse(raw);
  const [issue] = await listIssues(c, access, { id: issueId });
  if (!issue) throw forbidden();
  const role = assertCan(access, "issues.respond", { assigneeUserId: issue.assigned_to_user_id });
  if (input.documentId) {
    const document = (await c.query("SELECT uploaded_by_user_id FROM documents WHERE tenant_id = $1 AND id = $2",
      [access.tenantId, input.documentId])).rows[0];
    if (!document || !can(access, "documents.view", { ownerUserId: document.uploaded_by_user_id })) {
      throw invalid("INVALID_REFERENCE");
    }
  }
  const { rowCount } = await c.query(
    `UPDATE blocking_issues SET status = 'ANSWERED_PENDING_BPO_VALIDATION', client_response_text = $3,
        response_document_id = $4, responded_by_user_id = $5, responded_by_role = $6, responded_at = now()
      WHERE tenant_id = $1 AND id = $2 AND status = 'WAITING_CLIENT_RESPONSE'`,
    [access.tenantId, issueId, input.text, input.documentId ?? null, access.userId, role]);
  if (!rowCount) throw conflict("INVALID_TRANSITION");
  return { status: "ANSWERED_PENDING_BPO_VALIDATION" };
}

export const validationInput = z.strictObject({
  decision: z.enum(["ACCEPT", "REJECT"]),
  reason: z.string().trim().min(3).max(1000),
});

/** ACCEPT resolve; REJECT devolve ao cliente. O motivo fica na auditoria. */
export async function validateIssue(c: pg.PoolClient, access: Access, issueId: string, raw: unknown) {
  const input = validationInput.parse(raw);
  await c.query("SELECT set_config('app.change_reason', $1, true)", [input.reason]);
  const accept = input.decision === "ACCEPT";
  const { rows } = await c.query(
    `UPDATE blocking_issues SET status = $3, resolved_by_user_id = $4, resolved_at = $5
      WHERE tenant_id = $1 AND id = $2 AND status = ANY($6) RETURNING status`,
    [access.tenantId, issueId, accept ? "RESOLVED" : "WAITING_CLIENT_RESPONSE",
     accept ? access.userId : null, accept ? new Date() : null,
     accept ? ["ANSWERED_PENDING_BPO_VALIDATION", "WAITING_BPO_ACTION"] : ["ANSWERED_PENDING_BPO_VALIDATION"]]);
  if (!rows[0]) throw conflict("INVALID_TRANSITION");
  return rows[0];
}

export const reopenInput = z.strictObject({ reason: z.string().trim().min(10).max(1000) });

/** Nova divergência: volta a aguardar o responsável original. */
export async function reopenIssue(c: pg.PoolClient, access: Access, issueId: string, raw: unknown) {
  const input = reopenInput.parse(raw);
  await c.query("SELECT set_config('app.change_reason', $1, true)", [input.reason]);
  const reopened = await c.query(
    `UPDATE blocking_issues SET status = 'REOPENED', resolved_by_user_id = NULL, resolved_at = NULL
      WHERE tenant_id = $1 AND id = $2 AND status IN ('RESOLVED','ACCEPTED_WITH_CAVEAT') RETURNING assigned_to_side`,
    [access.tenantId, issueId]);
  if (!reopened.rows[0]) throw conflict("INVALID_TRANSITION");
  const status = reopened.rows[0].assigned_to_side === "CLIENT" ? "WAITING_CLIENT_RESPONSE" : "WAITING_BPO_ACTION";
  await c.query("UPDATE blocking_issues SET status = $2 WHERE id = $1", [issueId, status]);
  return { status };
}
