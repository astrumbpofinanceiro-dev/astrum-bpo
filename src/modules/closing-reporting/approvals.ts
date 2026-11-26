/** Dupla aprovação conforme a política do cliente (D11). */
import type pg from "pg";
import { Decimal } from "decimal.js";
import { z } from "zod";
import { conflict, forbidden } from "../../shared/errors";
import type { Access } from "../identity-access/authorize";
import { refundInput, refundSale, reversalInput, reverseAnticipation, reverseSettlement } from "../receivables/cards";
import { resolveSetting, today } from "../tenants-config/settings";
import { publish, publishInput, reopenInput, reopenPeriod } from "./closing";

export type Action = "PUBLISH_WITH_CAVEATS" | "REOPEN" | "REFUND" | "REVERSE_SETTLEMENT" | "REVERSE_ANTICIPATION";

/** Valor do estorno, para comparar com o limite de relevância. */
async function adjustmentValue(c: pg.PoolClient, t: string, action: Action, target: string | null, payload: Record<string, unknown>) {
  if (action === "REFUND") return refundInput.parse(payload).amount;
  const table = action === "REVERSE_SETTLEMENT"
    ? "SELECT gross_amount AS v FROM settlement_events" : "SELECT gross_anticipated_amount AS v FROM receivable_anticipations";
  const row = (await c.query(`${table} WHERE tenant_id = $1 AND id = $2`, [t, target])).rows[0];
  if (!row) throw forbidden();
  return row.v as string;
}

const SCHEMAS = {
  PUBLISH_WITH_CAVEATS: publishInput, REOPEN: reopenInput, REFUND: refundInput,
  REVERSE_SETTLEMENT: reversalInput, REVERSE_ANTICIPATION: reversalInput,
} as const;

function execute(c: pg.PoolClient, access: Access, action: Action, target: string | null, payload: unknown,
                 second: string | null, requester: string): Promise<object> {
  switch (action) {
    case "PUBLISH_WITH_CAVEATS": return publish(c, access, payload, second, requester);
    case "REOPEN": return reopenPeriod(c, access, payload);
    case "REFUND": return refundSale(c, access, target!, payload);
    case "REVERSE_SETTLEMENT": return reverseSettlement(c, access, target!, payload);
    case "REVERSE_ANTICIPATION": return reverseAnticipation(c, access, target!, payload);
  }
}

/** Executa na hora ou deixa pendente de outra pessoa. */
export async function guarded(c: pg.PoolClient, access: Access, action: Action, target: string | null, raw: unknown) {
  const payload = SCHEMAS[action].parse(raw) as Record<string, unknown>;
  const t = access.tenantId;
  let required = (await resolveSetting(c, t, "DUAL_APPROVAL_ENABLED", today())) === true;
  if (required && (action === "REFUND" || action.startsWith("REVERSE_"))) {
    const threshold = await resolveSetting(c, t, "DUAL_APPROVAL_THRESHOLD", today());
    required = threshold === null || new Decimal(await adjustmentValue(c, t, action, target, payload)).greaterThanOrEqualTo(threshold);
  }
  if (!required) return execute(c, access, action, target, payload, null, access.userId);
  const { rows } = await c.query(
    `INSERT INTO approval_records (tenant_id, action, target_id, payload, requested_by_user_id)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`, [t, action, target, JSON.stringify(payload), access.userId]);
  return { pendingApprovalId: rows[0].id as string };
}

export async function listApprovals(c: pg.PoolClient, access: Access) {
  return (await c.query(
    `SELECT a.id, a.action, a.payload, a.created_at, a.requested_by_user_id, u.full_name AS requested_by
       FROM approval_records a LEFT JOIN users u ON u.id = a.requested_by_user_id
      WHERE a.tenant_id = $1 AND a.status = 'PENDING' ORDER BY a.created_at`, [access.tenantId])).rows;
}

export const decisionInput = z.strictObject({ decision: z.enum(["APPROVE", "REJECT"]) });

export async function decide(c: pg.PoolClient, access: Access, id: string, raw: unknown) {
  const { decision } = decisionInput.parse(raw);
  const row = (await c.query(
    "SELECT * FROM approval_records WHERE tenant_id = $1 AND id = $2 FOR UPDATE", [access.tenantId, id])).rows[0];
  if (!row) throw forbidden();
  if (row.status !== "PENDING") throw conflict("INVALID_TRANSITION");
  // Quem pediu pode desistir, mas não pode aprovar.
  if (decision === "APPROVE" && row.requested_by_user_id === access.userId) throw conflict("SECOND_PERSON_REQUIRED");
  await c.query("UPDATE approval_records SET status = $2, decided_by_user_id = $3, decided_at = now() WHERE id = $1",
    [id, decision === "APPROVE" ? "APPROVED" : "REJECTED", access.userId]);
  if (decision === "REJECT") return { status: "REJECTED" };
  const result = await execute(c, access, row.action, row.target_id, row.payload, access.userId, row.requested_by_user_id);
  return { status: "APPROVED", result };
}
