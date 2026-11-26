/** Conciliação 1:1, N:1, 1:N e transferências internas (Doc 3 §2 e §3.4). */
import type pg from "pg";
import { z } from "zod";
import { conflict, forbidden, invalid } from "../../shared/errors";
import type { Access } from "../identity-access/authorize";
import { feeCompetence } from "../receivables/cards";
import { date, dec, fixed, positive, reason, requireRow, tolerance, total } from "../financial-core/common";

export const reconciliationInput = z.strictObject({
  matchMethod: z.enum(["EXACT_RULE", "MANUAL_BPO"]).default("MANUAL_BPO"),
  notes: z.string().trim().max(1000).optional(),
  allocations: z.array(z.strictObject({
    movementType: z.enum(["BANK_TRANSACTION", "CASH_TRANSACTION"]),
    movementId: z.guid(),
    targetType: z.enum(["SETTLEMENT_EVENT", "OBLIGATION_INSTALLMENT", "INTERNAL_TRANSFER"]),
    targetId: z.guid(),
    amount: positive,
    /** Parte do valor acima que é juros ou multa (D9). */
    charge: z.strictObject({ type: z.enum(["INTEREST", "FINE"]), amount: positive, justification: reason }).optional(),
  })).min(1).max(500),
});

interface Movement { amount: string; direction: "CREDIT" | "DEBIT"; date: string; account: string }

async function movement(c: pg.PoolClient, tenantId: string, type: string, id: string): Promise<Movement> {
  return type === "BANK_TRANSACTION"
    ? requireRow<Movement>(c,
      `SELECT amount, direction, bank_posting_date AS date, financial_account_id AS account
         FROM bank_transactions WHERE tenant_id = $1 AND id = $2`, [tenantId, id])
    // Caixa só concilia depois de aprovado pelo BPO.
    : requireRow<Movement>(c,
      `SELECT amount, CASE direction WHEN 'INFLOW' THEN 'CREDIT' ELSE 'DEBIT' END AS direction,
              transaction_date AS date, financial_account_id AS account
         FROM cash_transactions WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL
          AND review_status IN ('APPROVED_FOR_LEDGER','LOCKED_IN_CLOSING')`, [tenantId, id], "CASH_ENTRY_NOT_APPROVED");
}

/** Doc 3 §2.3: centavos entre o crédito e o repasse viram ajuste, nunca somem. */
async function absorbCents(c: pg.PoolClient, tenantId: string, settlementId: string, m: Movement, allocated: string) {
  const e = await requireRow(c,
    `SELECT net_amount FROM settlement_events WHERE tenant_id = $1 AND id = $2 AND status = 'ACTIVE' FOR NO KEY UPDATE`,
    [tenantId, settlementId]);
  const difference = dec(e.net_amount!).minus(m.amount);
  if (difference.isZero() || allocated !== m.amount || difference.abs().greaterThan(await tolerance(c, tenantId))) return;
  const used = await c.query(
    `SELECT 1 FROM reconciliation_allocations a JOIN reconciliation_groups g ON g.id = a.group_id AND g.status = 'ACTIVE'
      WHERE a.tenant_id = $1 AND a.right_entity_type = 'SETTLEMENT_EVENT' AND a.right_entity_id = $2`, [tenantId, settlementId]);
  if (used.rowCount) return;
  const origin = await requireRow(c,
    `SELECT s.installment_id, e.settlement_date, p.competence_date FROM settlement_allocations s
       JOIN settlement_events e ON e.id = s.settlement_event_id
       JOIN obligation_installments i ON i.id = s.installment_id
       JOIN financial_obligations o ON o.id = i.obligation_id
       LEFT JOIN economic_operations p ON p.id = o.economic_operation_id
      WHERE s.tenant_id = $1 AND s.settlement_event_id = $2 ORDER BY s.id LIMIT 1`, [tenantId, settlementId]);
  await c.query(
    `INSERT INTO settlement_fee_items (tenant_id, settlement_event_id, fee_type, amount, installment_id, competence_date)
     VALUES ($1,$2,'ADJUSTMENT',$3,$4,$5)`,
    [tenantId, settlementId, fixed(difference), origin.installment_id,
     await feeCompetence(c, tenantId, origin.competence_date ?? null, origin.settlement_date!)]);
  await c.query(
    "UPDATE settlement_events SET net_amount = $2, total_fees_amount = total_fees_amount + $3::numeric WHERE id = $1",
    [settlementId, m.amount, fixed(difference)]);
}

async function checkTarget(
  c: pg.PoolClient, tenantId: string, a: z.output<typeof reconciliationInput>["allocations"][number], m: Movement,
) {
  if (a.targetType === "OBLIGATION_INSTALLMENT") {
    const o = await requireRow(c,
      `SELECT o.direction FROM obligation_installments i JOIN financial_obligations o ON o.id = i.obligation_id
        WHERE i.tenant_id = $1 AND i.id = $2`, [tenantId, a.targetId]);
    if ((o.direction === "RECEIVABLE") !== (m.direction === "CREDIT")) throw invalid("DIRECTION_MISMATCH");
  } else if (a.targetType === "SETTLEMENT_EVENT") {
    if (a.movementType !== "BANK_TRANSACTION") throw invalid("INVALID_TARGET");
    await absorbCents(c, tenantId, a.targetId, m, a.amount);
    const e = await requireRow(c,
      `SELECT net_amount, financial_account_id FROM settlement_events WHERE tenant_id = $1 AND id = $2 AND status = 'ACTIVE'`,
      [tenantId, a.targetId]);
    if (e.financial_account_id !== m.account) throw invalid("ACCOUNT_MISMATCH");
    if (dec(e.net_amount!).isNegative() !== (m.direction === "DEBIT")) throw invalid("DIRECTION_MISMATCH");
  } else {
    const transfer = await requireRow(c,
      "SELECT from_account_id, to_account_id FROM internal_transfers WHERE tenant_id = $1 AND id = $2", [tenantId, a.targetId]);
    const expected = m.direction === "DEBIT" ? transfer.from_account_id : transfer.to_account_id;
    if (expected !== m.account) throw invalid("ACCOUNT_MISMATCH");
  }
  if (a.charge && (a.targetType !== "OBLIGATION_INSTALLMENT" || dec(a.charge.amount).greaterThan(a.amount))) {
    throw invalid("INVALID_CHARGE");
  }
}

export async function reconcile(c: pg.PoolClient, access: Access, raw: unknown) {
  const input = reconciliationInput.parse(raw);
  const t = access.tenantId;
  const groupId = (await c.query(
    `INSERT INTO reconciliation_groups (tenant_id, match_method, status, notes, created_by_user_id)
     VALUES ($1,$2,'ACTIVE',$3,$4) RETURNING id`, [t, input.matchMethod, input.notes ?? null, access.userId])).rows[0].id as string;
  for (const a of input.allocations) {
    const m = await movement(c, t, a.movementType, a.movementId);
    await checkTarget(c, t, a, m);
    if (a.charge) {
      await c.query(
        `INSERT INTO installment_charges (tenant_id, installment_id, reconciliation_group_id, charge_type, amount,
            competence_date, justification, created_by_user_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [t, a.targetId, groupId, a.charge.type, a.charge.amount, m.date, a.charge.justification, access.userId]);
    }
    await c.query(
      `INSERT INTO reconciliation_allocations (tenant_id, group_id, left_entity_type, left_entity_id,
          right_entity_type, right_entity_id, allocated_amount) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [t, groupId, a.movementType, a.movementId, a.targetType, a.targetId, a.amount]);
    // Juros/multa só cobrem o excedente: o principal precisa estar quitado.
    if (a.charge) {
      const open = await requireRow(c,
        "SELECT (gross_amount - settled_amount - cancelled_amount)::numeric(15,2) AS open FROM obligation_installments WHERE id = $1",
        [a.targetId]);
      if (!dec(open.open!).isZero()) throw invalid("CHARGE_ONLY_FOR_EXCESS");
    }
  }
  return { id: groupId };
}

export async function reverseReconciliation(c: pg.PoolClient, access: Access, groupId: string, raw: unknown) {
  const input = z.strictObject({ reason }).parse(raw);
  const group = (await c.query(
    "SELECT status FROM reconciliation_groups WHERE tenant_id = $1 AND id = $2 FOR UPDATE", [access.tenantId, groupId])).rows[0];
  if (!group) throw forbidden();
  if (group.status !== "ACTIVE") throw conflict("INVALID_TRANSITION");
  await c.query("SELECT set_config('app.change_reason', $1, true)", [input.reason]);
  await c.query("UPDATE reconciliation_groups SET status = 'REVERSED' WHERE id = $1", [groupId]);
  await c.query(
    `UPDATE internal_transfers t SET
        outflow_bank_tx_id = CASE WHEN t.outflow_bank_tx_id = a.left_entity_id THEN NULL ELSE t.outflow_bank_tx_id END,
        inflow_bank_tx_id = CASE WHEN t.inflow_bank_tx_id = a.left_entity_id THEN NULL ELSE t.inflow_bank_tx_id END
       FROM reconciliation_allocations a
      WHERE a.group_id = $1 AND a.right_entity_type = 'INTERNAL_TRANSFER' AND t.id = a.right_entity_id`, [groupId]);
  return { status: "REVERSED" };
}

export const transferInput = z.strictObject({
  fromAccountId: z.guid(), toAccountId: z.guid(), date, amount: positive,
  outflowBankTxId: z.guid().optional(), inflowBankTxId: z.guid().optional(),
});

/** Duas pernas; não é receita nem despesa. */
export async function createTransfer(c: pg.PoolClient, access: Access, raw: unknown) {
  const input = transferInput.parse(raw);
  const t = access.tenantId;
  if (input.fromAccountId === input.toAccountId) throw invalid("SAME_ACCOUNT");
  const legs = [
    [input.outflowBankTxId, "DEBIT", input.fromAccountId], [input.inflowBankTxId, "CREDIT", input.toAccountId],
  ] as const;
  for (const [id, direction, account] of legs) {
    if (!id) continue;
    const m = await movement(c, t, "BANK_TRANSACTION", id);
    if (m.direction !== direction || m.account !== account || !dec(m.amount).equals(input.amount)) {
      throw invalid("TRANSFER_LEG_MISMATCH");
    }
  }
  const id = (await c.query(
    `INSERT INTO internal_transfers (tenant_id, from_account_id, to_account_id, transfer_date, amount,
        outflow_bank_tx_id, inflow_bank_tx_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [t, input.fromAccountId, input.toAccountId, input.date, input.amount,
     input.outflowBankTxId ?? null, input.inflowBankTxId ?? null])).rows[0].id as string;
  const linked = legs.filter(([tx]) => tx);
  if (linked.length) {
    await reconcile(c, access, { allocations: linked.map(([tx]) => ({
      movementType: "BANK_TRANSACTION", movementId: tx, targetType: "INTERNAL_TRANSFER", targetId: id, amount: input.amount })) });
  }
  return { id };
}

/** Dias úteis entre duas datas (sábados e domingos fora; feriados não considerados). */
export function businessDaysBetween(from: string, to: string): number {
  let days = 0;
  const end = Date.parse(`${to}T00:00:00Z`);
  for (let d = Date.parse(`${from}T00:00:00Z`) + 86_400_000; d <= end; d += 86_400_000) {
    if (![0, 6].includes(new Date(d).getUTCDay())) days++;
  }
  return to < from ? -1 : days;
}

/**
 * Nível 2 (Doc 3 §2.1): mesma conta, direção e valor, com 0 a 2 dias úteis. Um candidato
 * vira sugestão; vários ficam para revisão manual. Nada é conciliado sozinho.
 */
export async function suggestMatches(c: pg.PoolClient, access: Access) {
  const t = access.tenantId;
  const limit = await tolerance(c, t);
  const movements = (await c.query(
    `SELECT id, financial_account_id, direction, amount, bank_posting_date AS date FROM bank_transactions
      WHERE tenant_id = $1 AND reconciliation_status IN ('UNRECONCILED','SUGGESTED_MATCH')
      ORDER BY bank_posting_date, id LIMIT 500`, [t])).rows;
  const targets = (await c.query(
    `SELECT 'SETTLEMENT_EVENT' AS type, e.id, e.financial_account_id AS account,
            CASE WHEN e.net_amount < 0 THEN 'DEBIT' ELSE 'CREDIT' END AS direction, abs(e.net_amount) AS amount,
            e.settlement_date AS date
       FROM settlement_events e WHERE e.tenant_id = $1 AND e.status = 'ACTIVE' AND NOT EXISTS (
         SELECT 1 FROM reconciliation_allocations a JOIN reconciliation_groups g ON g.id = a.group_id AND g.status = 'ACTIVE'
          WHERE a.right_entity_type = 'SETTLEMENT_EVENT' AND a.right_entity_id = e.id)
     UNION ALL
     SELECT 'OBLIGATION_INSTALLMENT', i.id, NULL, CASE o.direction WHEN 'RECEIVABLE' THEN 'CREDIT' ELSE 'DEBIT' END,
            i.gross_amount - i.settled_amount - i.cancelled_amount, i.due_date
       FROM obligation_installments i JOIN financial_obligations o ON o.id = i.obligation_id
       LEFT JOIN economic_operations p ON p.id = o.economic_operation_id
      -- recebíveis de cartão chegam pelo repasse, não direto na parcela
      WHERE i.tenant_id = $1 AND i.status IN ('OPEN','PARTIALLY_SETTLED','OVERDUE')
        AND NOT (o.direction = 'RECEIVABLE' AND p.acquirer_id IS NOT NULL)`, [t])).rows;

  const result = [];
  for (const m of movements) {
    const candidates = targets.filter((x) => {
      const days = businessDaysBetween(x.date, m.date);
      return x.direction === m.direction && (!x.account || x.account === m.financial_account_id) &&
        dec(x.amount).minus(m.amount).abs().lessThanOrEqualTo(x.type === "SETTLEMENT_EVENT" ? limit : 0) &&
        days >= 0 && days <= 2;
    });
    // Um repasse da adquirente pode vir como um crédito único para vários eventos (um por venda):
    // soma os eventos pendentes da mesma conta e data e compara com o crédito.
    const bundles = new Map<string, typeof targets>();
    for (const x of targets) {
      if (x.type !== "SETTLEMENT_EVENT") continue;
      const days = businessDaysBetween(x.date, m.date);
      if (x.direction !== m.direction || x.account !== m.financial_account_id || days < 0 || days > 2) continue;
      const key = `${x.account}|${x.date}`;
      bundles.set(key, [...(bundles.get(key) ?? []), x]);
    }
    const combinations = [...bundles.values()]
      .filter((g) => g.length > 1 && total(g.map((x) => x.amount)).minus(m.amount).abs().lessThanOrEqualTo(limit))
      .map((g) => ({ targets: g.map((x) => ({ targetType: x.type, targetId: x.id, amount: fixed(dec(x.amount)) })) }));
    const options = candidates.length + combinations.length;
    const status = options === 1 ? "SUGGESTED_MATCH" : "UNRECONCILED";
    await c.query("UPDATE bank_transactions SET reconciliation_status = $2 WHERE id = $1 AND reconciliation_status <> $2",
      [m.id, status]);
    if (options) {
      result.push({ movementId: m.id, ambiguous: options > 1,
        candidates: candidates.map((x) => ({ targetType: x.type, targetId: x.id, amount: m.amount })), combinations });
    }
  }
  return result;
}

export async function listMovements(c: pg.PoolClient, access: Access) {
  return (await c.query(
    `SELECT id, financial_account_id, bank_posting_date, direction, amount, description, reconciliation_status
       FROM bank_transactions WHERE tenant_id = $1 ORDER BY bank_posting_date DESC, id LIMIT 1000`, [access.tenantId])).rows;
}
