/** Operações econômicas com obrigação e parcelas (competência), inclusive vendas no cartão. */
import type pg from "pg";
import { z } from "zod";
import { conflict, forbidden, invalid } from "../../shared/errors";
import type { Access } from "../identity-access/authorize";
import { amount, date, dec, fixed, positive, split, total } from "./common";

export const operationInput = z.strictObject({
  operationType: z.enum(["SALE", "SERVICE", "PURCHASE", "EXPENSE"]),
  businessUnitId: z.guid().optional(),
  operationDate: date,
  /** Ausente = data da operação (Doc 1 §1). */
  competenceDate: date.optional(),
  grossAmount: positive,
  description: z.string().trim().min(3).max(300),
  counterpartyName: z.string().trim().max(180).optional(),
  categoryId: z.guid().optional(),
  costCenterId: z.guid().optional(),
  sourceDocumentId: z.guid().optional(),
  acquirerId: z.guid().optional(),
  externalNsuTid: z.string().trim().min(1).max(100).optional(),
  /** Taxa (MDR) prevista total, distribuída entre as parcelas quando elas não a informam. */
  expectedFeeAmount: amount.default("0.00"),
  installments: z.array(z.strictObject({
    dueDate: date, grossAmount: positive.optional(), expectedFeeAmount: amount.optional(),
  })).min(1).max(99),
});

export async function createOperation(
  c: pg.PoolClient, access: Access, raw: unknown, origin: "BPO_ENTRY" | "BATCH_IMPORT" = "BPO_ENTRY",
) {
  const input = operationInput.parse(raw);
  const n = input.installments.length;
  const informed = input.installments.filter((i) => i.grossAmount).length;
  if (informed !== 0 && informed !== n) throw invalid("INSTALLMENT_AMOUNTS_INCOMPLETE");
  const grosses = informed ? input.installments.map((i) => i.grossAmount!) : split(input.grossAmount, n);
  if (!total(grosses).equals(input.grossAmount)) throw invalid("INSTALLMENTS_DO_NOT_ADD_UP");
  const sharedFees = split(input.expectedFeeAmount, n);
  const fees = input.installments.map((i, k) => i.expectedFeeAmount ?? sharedFees[k]!);
  if (fees.some((f, k) => dec(f).greaterThan(grosses[k]!))) throw invalid("FEE_EXCEEDS_AMOUNT");
  if (input.externalNsuTid && input.acquirerId) {
    const same = await c.query(
      `SELECT 1 FROM economic_operations WHERE tenant_id = $1 AND acquirer_id = $2 AND external_nsu_tid = $3
          AND operation_type = 'SALE' AND review_status <> 'REJECTED' AND deleted_at IS NULL`,
      [access.tenantId, input.acquirerId, input.externalNsuTid]);
    if (same.rowCount) throw conflict("SALE_ALREADY_EXISTS");
  }

  const op = (await c.query(
    `INSERT INTO economic_operations (tenant_id, business_unit_id, operation_type, origin_type, created_by_user_id,
        source_document_id, acquirer_id, external_nsu_tid, category_id, cost_center_id, operation_date,
        competence_date, gross_amount, description)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
    [access.tenantId, input.businessUnitId ?? null, input.operationType, origin, access.userId,
     input.sourceDocumentId ?? null, input.acquirerId ?? null, input.externalNsuTid ?? null, input.categoryId ?? null,
     input.costCenterId ?? null, input.operationDate, input.competenceDate ?? input.operationDate,
     input.grossAmount, input.description])).rows[0].id as string;
  const direction = ["SALE", "SERVICE"].includes(input.operationType) ? "RECEIVABLE" : "PAYABLE";
  const obligation = (await c.query(
    `INSERT INTO financial_obligations (tenant_id, economic_operation_id, direction, counterparty_name, total_amount, status)
     VALUES ($1,$2,$3,$4,$5,'OPEN') RETURNING id`,
    [access.tenantId, op, direction, input.counterpartyName ?? null, input.grossAmount])).rows[0].id as string;

  const installmentIds: string[] = [];
  for (const [k, i] of input.installments.entries()) {
    installmentIds.push((await c.query(
      `INSERT INTO obligation_installments (tenant_id, obligation_id, installment_number, total_installments, gross_amount,
          expected_fee_amount, net_expected_amount, due_date, original_expected_settlement_date,
          current_expected_settlement_date, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,$8,'OPEN') RETURNING id`,
      [access.tenantId, obligation, k + 1, n, grosses[k], fees[k], fixed(dec(grosses[k]!).minus(fees[k]!)), i.dueDate])).rows[0].id);
  }
  return { id: op, obligationId: obligation, installmentIds };
}

export const approvalInput = z.strictObject({ operationIds: z.array(z.guid()).min(1).max(500) });

/** Só operação aprovada entra nas visões de competência (Doc 3 §4.1). */
export async function approveOperations(c: pg.PoolClient, access: Access, raw: unknown) {
  const { operationIds } = approvalInput.parse(raw);
  const { rowCount } = await c.query(
    `UPDATE economic_operations SET review_status = 'APPROVED_FOR_LEDGER'
      WHERE tenant_id = $1 AND id = ANY($2) AND deleted_at IS NULL
        AND review_status IN ('SUBMITTED_PENDING_BPO','UNDER_BPO_REVIEW')`, [access.tenantId, operationIds]);
  if (rowCount !== operationIds.length) throw conflict("INVALID_TRANSITION");
  return { approved: rowCount };
}

export async function getOperation(c: pg.PoolClient, access: Access, id: string) {
  const op = (await c.query(
    `SELECT id, operation_type, review_status, operation_date, competence_date, gross_amount, description,
            acquirer_id, external_nsu_tid, reversal_of_operation_id
       FROM economic_operations WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL`, [access.tenantId, id])).rows[0];
  if (!op) throw forbidden();
  const installments = (await c.query(
    `SELECT i.id, o.direction, i.installment_number, i.total_installments, i.gross_amount, i.expected_fee_amount,
            i.settled_amount, i.cancelled_amount, i.due_date, i.original_expected_settlement_date,
            i.current_expected_settlement_date, i.status
       FROM obligation_installments i JOIN financial_obligations o ON o.id = i.obligation_id
      WHERE i.tenant_id = $1 AND o.economic_operation_id = $2 ORDER BY i.installment_number`, [access.tenantId, id])).rows;
  return { ...op, installments };
}

/** Parcelas com saldo em aberto: base do fluxo previsto (Doc 3 §4.3) e da conciliação. */
export async function listOpenInstallments(c: pg.PoolClient, access: Access) {
  return (await c.query(
    `SELECT i.id, o.direction, o.economic_operation_id, i.installment_number, i.total_installments,
            (i.gross_amount - i.settled_amount - i.cancelled_amount)::numeric(15,2) AS open_amount,
            i.due_date, i.current_expected_settlement_date, i.status,
            i.current_expected_settlement_date < (now() AT TIME ZONE 'America/Sao_Paulo')::date AS overdue
       FROM obligation_installments i JOIN financial_obligations o ON o.id = i.obligation_id
      WHERE i.tenant_id = $1 AND i.status IN ('OPEN','PARTIALLY_SETTLED','OVERDUE')
      ORDER BY i.current_expected_settlement_date, i.id LIMIT 1000`, [access.tenantId])).rows;
}

export const rejectionInput = z.strictObject({ reason: z.string().trim().min(10).max(1000) });

/** Recusa um lançamento ainda não aprovado e sem nenhum valor recebido ou pago. */
export async function rejectOperation(c: pg.PoolClient, access: Access, id: string, raw: unknown) {
  const input = rejectionInput.parse(raw);
  await c.query("SELECT set_config('app.change_reason', $1, true)", [input.reason]);
  const used = await c.query(
    `SELECT 1 FROM obligation_installments i JOIN financial_obligations o ON o.id = i.obligation_id
      WHERE i.tenant_id = $1 AND o.economic_operation_id = $2 AND i.settled_amount > 0 FOR UPDATE OF i`, [access.tenantId, id]);
  if (used.rowCount) throw conflict("OPERATION_HAS_SETTLEMENTS");
  const { rowCount } = await c.query(
    `UPDATE economic_operations SET review_status = 'REJECTED' WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL
        AND operation_type <> 'REFUND_REVERSAL' AND review_status IN ('SUBMITTED_PENDING_BPO','UNDER_BPO_REVIEW')`,
    [access.tenantId, id]);
  if (!rowCount) throw conflict("INVALID_TRANSITION");
  await c.query(
    `UPDATE obligation_installments i SET cancelled_amount = i.gross_amount FROM financial_obligations o
      WHERE o.id = i.obligation_id AND i.tenant_id = $1 AND o.economic_operation_id = $2`, [access.tenantId, id]);
  return { reviewStatus: "REJECTED" };
}
