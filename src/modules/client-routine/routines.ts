/** Rotina de entrega do cliente (checklist). */
import type pg from "pg";
import { z } from "zod";
import { conflict, forbidden, invalid } from "../../shared/errors";
import { can, type Access } from "../identity-access/authorize";
import { monthRange } from "../closing-reporting/reports";

export const routineInput = z.strictObject({
  title: z.string().trim().min(3).max(150),
  businessUnitId: z.guid().optional(),
  frequency: z.enum(["DAILY", "WEEKLY", "BIWEEKLY", "MONTHLY"]),
  expectedSourceType: z.enum(["BANK_STATEMENT", "ACQUIRER_REPORT", "CASH_SUMMARY", "EXPENSE_RECEIPTS"]),
  /** Dias após o fim do período coberto. */
  dueDayOffset: z.number().int().min(0).max(60).default(1),
});

export async function createRoutine(c: pg.PoolClient, access: Access, raw: unknown) {
  const i = routineInput.parse(raw);
  const { rows } = await c.query(
    `INSERT INTO client_routines (tenant_id, business_unit_id, title, frequency, expected_source_type, due_day_offset)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [access.tenantId, i.businessUnitId ?? null, i.title, i.frequency, i.expectedSourceType, i.dueDayOffset]);
  return { id: rows[0].id };
}

/** Fim de cada período do mês: diário, domingos, dias 15 e último, ou último. */
export function periodEnds(month: string, frequency: string): string[] {
  const last = Number(monthRange(month)[1].slice(8));
  const date = (d: number) => `${month}-${String(d).padStart(2, "0")}`;
  const all = Array.from({ length: last }, (_, i) => i + 1);
  const days = frequency === "DAILY" ? all
    : frequency === "WEEKLY" ? all.filter((d) => new Date(`${date(d)}T00:00:00Z`).getUTCDay() === 0)
    : frequency === "BIWEEKLY" ? [15, last] : [last];
  return days.map(date);
}

export async function generateItems(c: pg.PoolClient, access: Access, month: string) {
  const routines = (await c.query(
    "SELECT id, frequency, due_day_offset FROM client_routines WHERE tenant_id = $1 AND is_active", [access.tenantId])).rows;
  let created = 0;
  for (const r of routines) {
    for (const end of periodEnds(month, r.frequency)) {
      created += (await c.query(
        `INSERT INTO routine_items (tenant_id, routine_id, competence_date, due_date, status)
         VALUES ($1,$2,$3,$4::date + $5::int,'PENDING') ON CONFLICT (routine_id, due_date) DO NOTHING`,
        [access.tenantId, r.id, `${month}-01`, end, r.due_day_offset])).rowCount ?? 0;
    }
  }
  return { created };
}

export async function listItems(c: pg.PoolClient, access: Access, month: string) {
  const { rows } = await c.query(
    `SELECT i.id, r.title, r.expected_source_type, r.business_unit_id, i.due_date, i.linked_document_id,
            CASE WHEN i.status = 'PENDING' AND i.due_date < (now() AT TIME ZONE 'America/Sao_Paulo')::date
                 THEN 'OVERDUE' ELSE i.status END AS status
       FROM routine_items i JOIN client_routines r ON r.id = i.routine_id
      WHERE i.tenant_id = $1 AND i.competence_date = $2 ORDER BY i.due_date, r.title`, [access.tenantId, `${month}-01`]);
  return rows.filter((r) => can(access, "structure.view", { businessUnitId: r.business_unit_id }));
}

export const itemInput = z.strictObject({
  action: z.enum(["SUBMIT", "COMPLETE", "WAIVE"]),
  documentId: z.guid().optional(),
});

export async function updateItem(c: pg.PoolClient, access: Access, id: string, raw: unknown) {
  const input = itemInput.parse(raw);
  const item = (await c.query(
    `SELECT r.business_unit_id FROM routine_items i JOIN client_routines r ON r.id = i.routine_id
      WHERE i.tenant_id = $1 AND i.id = $2`, [access.tenantId, id])).rows[0];
  if (!item || !can(access, "structure.view", { businessUnitId: item.business_unit_id })) throw forbidden();
  if (input.action === "SUBMIT") {
    if (!input.documentId) throw invalid("DOCUMENT_REQUIRED");
    const doc = (await c.query(
      "SELECT uploaded_by_user_id FROM documents WHERE tenant_id = $1 AND id = $2 AND receipt_status = 'RECEIVED'",
      [access.tenantId, input.documentId])).rows[0];
    if (!doc || !can(access, "documents.view", { ownerUserId: doc.uploaded_by_user_id })) throw invalid("INVALID_REFERENCE");
  } else if (!can(access, "processing.operate")) {
    throw forbidden();
  }
  const [status, from] = input.action === "SUBMIT" ? ["SUBMITTED", ["PENDING", "OVERDUE"]]
    : input.action === "COMPLETE" ? ["COMPLETED", ["PENDING", "OVERDUE", "SUBMITTED"]]
    : ["WAIVED", ["PENDING", "OVERDUE"]];
  const { rowCount } = await c.query(
    `UPDATE routine_items SET status = $3, linked_document_id = COALESCE($4, linked_document_id),
        completed_at = CASE WHEN $3 = 'COMPLETED' THEN now() ELSE completed_at END
      WHERE tenant_id = $1 AND id = $2 AND status = ANY($5)`,
    [access.tenantId, id, status, input.documentId ?? null, from]);
  if (!rowCount) throw conflict("INVALID_TRANSITION");
  return { status };
}
