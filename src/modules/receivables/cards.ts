/** Liquidação, antecipação e estorno/chargeback (Doc 3 §3). */
import type pg from "pg";
import { Decimal } from "decimal.js";
import { z } from "zod";
import { conflict, forbidden, invalid } from "../../shared/errors";
import type { Access } from "../identity-access/authorize";
import { amount, date, dec, fixed, positive, reason, requireRow, tolerance, total } from "../financial-core/common";

const line = z.strictObject({
  installmentId: z.guid(),
  grossAmount: positive,
  mdrFee: amount.default("0.00"),
  anticipationFee: amount.default("0.00"),
  fixedFee: amount.default("0.00"),
  /** Líquido informado pela adquirente para esta linha; permite um evento por venda. */
  netAmount: amount.optional(),
});
type Line = z.output<typeof line>;

export const settlementInput = z.strictObject({
  financialAccountId: z.guid(),
  acquirerId: z.guid(),
  settlementDate: date,
  items: z.array(line).min(1).max(1000),
  /** Estornos descontados neste repasse (parcela a pagar gerada pelo estorno). */
  chargebacks: z.array(z.strictObject({ installmentId: z.guid(), amount: positive })).default([]),
  /** Líquido informado pela adquirente; diferença de centavos vira ajuste rastreável. */
  netAmount: amount.optional(),
});

export const anticipationInput = z.strictObject({
  financialAccountId: z.guid(),
  acquirerId: z.guid(),
  requestedAt: date,
  effectiveDate: date,
  sourceDocumentId: z.guid().optional(),
  items: z.array(line).min(1).max(1000),
  netAmount: amount.optional(),
});

interface Installment {
  id: string; direction: string; acquirer_id: string | null; competence_date: string | null; open: string;
  operation_id: string | null;
}

async function installment(c: pg.PoolClient, tenantId: string, id: string): Promise<Installment> {
  return requireRow<Installment>(c,
    `SELECT i.id, o.direction, p.acquirer_id, p.competence_date, p.id AS operation_id,
            (i.gross_amount - i.settled_amount - i.cancelled_amount)::numeric(15,2) AS open
       FROM obligation_installments i JOIN financial_obligations o ON o.id = i.obligation_id
       LEFT JOIN economic_operations p ON p.id = o.economic_operation_id
      WHERE i.tenant_id = $1 AND i.id = $2 FOR NO KEY UPDATE OF i`, [tenantId, id]);
}

/**
 * Competência da taxa = a da venda (D7). Se o mês da venda já foi fechado, a taxa entra no
 * mês do evento, como ajuste em competência posterior (Doc 1, Exceção 7).
 */
export async function feeCompetence(c: pg.PoolClient, tenantId: string, saleDate: string | null, eventDate: string) {
  if (!saleDate) return eventDate;
  const closed = await c.query(
    `SELECT 1 FROM period_closings WHERE tenant_id = $1 AND competence_date = date_trunc('month', $2::date)
        AND status IN ('CLOSED_PUBLISHED','CLOSED_WITH_CAVEATS')`, [tenantId, saleDate]);
  return closed.rowCount ? eventDate : saleDate;
}

const feesOf = (l: Line) => [["MDR", l.mdrFee], ["ANTICIPATION_FEE", l.anticipationFee], ["FIXED_FEE", l.fixedFee]] as const;

/** Cria o evento de repasse com alocações e taxas. Usado também pela antecipação. */
async function createEvent(
  c: pg.PoolClient, access: Access, e: {
    accountId: string; acquirerId: string; date: string; items: Line[];
    chargebacks: { installmentId: string; amount: string }[]; netAmount?: string; anticipationId?: string;
  },
) {
  const t = access.tenantId;
  const gross = total(e.items.map((i) => i.grossAmount));
  const fees = total(e.items.flatMap((i) => feesOf(i).map(([, v]) => v)));
  const charged = total(e.chargebacks.map((x) => x.amount));
  const computed = gross.minus(fees).minus(charged);
  const adjustment: Decimal = e.netAmount === undefined ? dec() : computed.minus(e.netAmount);
  if (adjustment.abs().greaterThan(await tolerance(c, t))) throw invalid("NET_AMOUNT_DIVERGES");
  const net = computed.minus(adjustment);

  const eventId = (await c.query(
    `INSERT INTO settlement_events (tenant_id, financial_account_id, acquirer_id, settlement_date, gross_amount,
        total_fees_amount, net_amount, anticipation_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [t, e.accountId, e.acquirerId, e.date, fixed(gross), fixed(fees.plus(adjustment)), fixed(net),
     e.anticipationId ?? null])).rows[0].id as string;

  const fee = async (type: string, value: string, installmentId: string, competence: string) =>
    c.query(
      `INSERT INTO settlement_fee_items (tenant_id, settlement_event_id, fee_type, amount, installment_id, competence_date)
       VALUES ($1,$2,$3,$4,$5,$6)`, [t, eventId, type, value, installmentId, competence]);

  let first: { id: string; competence: string } | undefined;
  for (const item of e.items) {
    const i = await installment(c, t, item.installmentId);
    if (i.direction !== "RECEIVABLE" || (i.acquirer_id && i.acquirer_id !== e.acquirerId)) throw invalid("INVALID_INSTALLMENT");
    // Na antecipação o saldo já foi consumido pela alocação antecipada.
    if (!e.anticipationId && dec(item.grossAmount).greaterThan(i.open)) throw conflict("ALLOCATION_EXCEEDS_BALANCE");
    const itemFees = total(feesOf(item).map(([, v]) => v));
    if (itemFees.greaterThan(item.grossAmount)) throw invalid("FEE_EXCEEDS_AMOUNT");
    await c.query(
      `INSERT INTO settlement_allocations (tenant_id, settlement_event_id, installment_id, allocated_gross_amount, allocated_net_amount)
       VALUES ($1,$2,$3,$4,$5)`, [t, eventId, i.id, item.grossAmount, fixed(dec(item.grossAmount).minus(itemFees))]);
    const competence = await feeCompetence(c, t, i.competence_date, e.date);
    first ??= { id: i.id, competence };
    for (const [type, value] of feesOf(item)) if (dec(value).greaterThan(0)) await fee(type, value, i.id, competence);
  }
  for (const x of e.chargebacks) {
    const i = await installment(c, t, x.installmentId);
    if (i.direction !== "PAYABLE" || dec(x.amount).greaterThan(i.open)) throw invalid("INVALID_CHARGEBACK");
    await fee("CHARGEBACK", x.amount, i.id, e.date);
  }
  if (!adjustment.isZero()) await fee("ADJUSTMENT", fixed(adjustment), first!.id, first!.competence);
  return { id: eventId, grossAmount: fixed(gross), netAmount: fixed(net) };
}

const noRepeat = (items: { installmentId: string }[]) => {
  if (new Set(items.map((i) => i.installmentId)).size !== items.length) throw invalid("REPEATED_INSTALLMENT");
};

export async function createSettlement(c: pg.PoolClient, access: Access, raw: unknown) {
  const input = settlementInput.parse(raw);
  noRepeat(input.items);
  if (input.items.some((i) => dec(i.anticipationFee).greaterThan(0))) throw invalid("USE_ANTICIPATION");
  return createEvent(c, access, { accountId: input.financialAccountId, acquirerId: input.acquirerId,
    date: input.settlementDate, items: input.items, chargebacks: input.chargebacks,
    netAmount: input.netAmount ?? (input.items.every((i) => i.netAmount !== undefined)
      ? fixed(total(input.items.map((i) => i.netAmount!)).minus(total(input.chargebacks.map((x) => x.amount)))) : undefined) });
}

/** Antecipação total ou parcial: a previsão original nunca é apagada. */
export async function createAnticipation(c: pg.PoolClient, access: Access, raw: unknown) {
  const input = anticipationInput.parse(raw);
  noRepeat(input.items);
  const gross = total(input.items.map((i) => i.grossAmount));
  const anticipationFee = total(input.items.map((i) => i.anticipationFee));
  const lineNet = (i: Line) => dec(i.grossAmount).minus(total(feesOf(i).map(([, v]) => v)));
  const net = total(input.items.map(lineNet));
  if (input.items.some((i) => lineNet(i).isNegative())) throw invalid("FEE_EXCEEDS_AMOUNT");

  const id = (await c.query(
    `INSERT INTO receivable_anticipations (tenant_id, acquirer_id, requested_at, effective_date, gross_anticipated_amount,
        anticipation_fee_amount, net_anticipated_amount, source_document_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [access.tenantId, input.acquirerId, input.requestedAt, input.effectiveDate, fixed(gross), fixed(anticipationFee),
     fixed(net), input.sourceDocumentId ?? null])).rows[0].id as string;
  for (const item of input.items) {
    const i = await installment(c, access.tenantId, item.installmentId);
    if (i.direction !== "RECEIVABLE") throw invalid("INVALID_INSTALLMENT");
    if (dec(item.grossAmount).greaterThan(i.open)) throw conflict("ALLOCATION_EXCEEDS_BALANCE");
    await c.query(
      `INSERT INTO anticipation_allocations (tenant_id, anticipation_id, installment_id, gross_allocated, fee_allocated, net_allocated)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [access.tenantId, id, i.id, item.grossAmount, item.anticipationFee, fixed(lineNet(item))]);
  }
  // Com o líquido de cada linha, o repasse é dividido em um evento por venda (Doc 3 §7, cenário 6);
  // sem ele, mantém-se um único evento com o líquido total informado.
  const perSale = input.items.every((i) => i.netAmount !== undefined);
  const buckets = new Map<string, Line[]>();
  for (const item of input.items) {
    const key = perSale ? ((await installment(c, access.tenantId, item.installmentId)).operation_id ?? item.installmentId) : "all";
    buckets.set(key, [...(buckets.get(key) ?? []), item]);
  }
  const events = [];
  for (const items of buckets.values()) {
    events.push(await createEvent(c, access, { accountId: input.financialAccountId, acquirerId: input.acquirerId,
      date: input.effectiveDate, items, chargebacks: [],
      netAmount: perSale ? fixed(total(items.map((i) => i.netAmount!))) : input.netAmount, anticipationId: id }));
  }
  return { id, settlementId: events[0]!.id, settlementIds: events.map((e) => e.id),
    netAmount: fixed(total(events.map((e) => e.netAmount))) };
}

export const reversalInput = z.strictObject({ reason });

/** D10: marca como estornado; o histórico permanece e deixa de contar nos saldos. */
export async function reverseSettlement(c: pg.PoolClient, access: Access, id: string, raw: unknown) {
  const input = reversalInput.parse(raw);
  const row = (await c.query(
    "SELECT anticipation_id, status FROM settlement_events WHERE tenant_id = $1 AND id = $2 FOR UPDATE", [access.tenantId, id])).rows[0];
  if (!row) throw forbidden();
  if (row.anticipation_id) throw conflict("REVERSE_ANTICIPATION_INSTEAD");
  if (row.status !== "ACTIVE") throw conflict("INVALID_TRANSITION");
  await c.query("UPDATE settlement_events SET status = 'REVERSED', reversal_reason = $2 WHERE id = $1", [id, input.reason]);
  return { status: "REVERSED" };
}

export async function reverseAnticipation(c: pg.PoolClient, access: Access, id: string, raw: unknown) {
  const input = reversalInput.parse(raw);
  const row = (await c.query(
    "SELECT status FROM receivable_anticipations WHERE tenant_id = $1 AND id = $2 FOR UPDATE", [access.tenantId, id])).rows[0];
  if (!row) throw forbidden();
  if (row.status !== "ACTIVE") throw conflict("INVALID_TRANSITION");
  await c.query(
    `UPDATE settlement_events SET status = 'REVERSED', reversal_reason = $3
      WHERE tenant_id = $1 AND anticipation_id = $2 AND status = 'ACTIVE'`, [access.tenantId, id, input.reason]);
  await c.query("UPDATE receivable_anticipations SET status = 'REVERSED', reversal_reason = $2 WHERE id = $1", [id, input.reason]);
  return { status: "REVERSED" };
}

export const refundInput = z.strictObject({ amount: positive, date, reason });

/**
 * Estorno/chargeback: a venda original é preservada. Primeiro reduz parcelas em aberto
 * (da última para a primeira); o que já foi recebido vira obrigação a pagar.
 */
export async function refundSale(c: pg.PoolClient, access: Access, saleId: string, raw: unknown) {
  const input = refundInput.parse(raw);
  const t = access.tenantId;
  const sale = (await c.query(
    `SELECT * FROM economic_operations WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL
        AND operation_type IN ('SALE','SERVICE') AND review_status <> 'REJECTED' FOR NO KEY UPDATE`, [t, saleId])).rows[0];
  if (!sale) throw forbidden();
  const refunded = (await c.query(
    `SELECT COALESCE(SUM(gross_amount), 0) AS v FROM economic_operations
      WHERE tenant_id = $1 AND reversal_of_operation_id = $2 AND deleted_at IS NULL AND review_status <> 'REJECTED'`,
    [t, saleId])).rows[0].v;
  if (dec(refunded).plus(input.amount).greaterThan(sale.gross_amount)) throw conflict("REFUND_EXCEEDS_SALE");

  // Quem lança é Revisor/Master (E5), por isso o estorno nasce aprovado.
  const refundId = (await c.query(
    `INSERT INTO economic_operations (tenant_id, business_unit_id, operation_type, origin_type, created_by_user_id,
        acquirer_id, external_nsu_tid, category_id, cost_center_id, operation_date, competence_date, gross_amount,
        description, review_status, reversal_of_operation_id)
     VALUES ($1,$2,'REFUND_REVERSAL','BPO_ENTRY',$3,$4,$5,$6,$7,$8,$8,$9,$10,'APPROVED_FOR_LEDGER',$11) RETURNING id`,
    [t, sale.business_unit_id, access.userId, sale.acquirer_id, sale.external_nsu_tid, sale.category_id,
     sale.cost_center_id, input.date, input.amount, input.reason.slice(0, 300), saleId])).rows[0].id as string;

  let remaining = dec(input.amount);
  const open = (await c.query(
    `SELECT i.id, (i.gross_amount - i.settled_amount - i.cancelled_amount)::numeric(15,2) AS open
       FROM obligation_installments i JOIN financial_obligations o ON o.id = i.obligation_id
      WHERE i.tenant_id = $1 AND o.economic_operation_id = $2 ORDER BY i.installment_number DESC FOR NO KEY UPDATE OF i`,
    [t, saleId])).rows;
  for (const i of open) {
    const cut = Decimal.min(remaining, i.open);
    if (cut.lessThanOrEqualTo(0)) continue;
    await c.query("UPDATE obligation_installments SET cancelled_amount = cancelled_amount + $2 WHERE id = $1", [i.id, fixed(cut)]);
    remaining = remaining.minus(cut);
  }

  let chargebackInstallmentId: string | null = null;
  if (remaining.greaterThan(0)) {
    const obligation = (await c.query(
      `INSERT INTO financial_obligations (tenant_id, economic_operation_id, direction, counterparty_name, total_amount, status)
       VALUES ($1,$2,'PAYABLE','Estorno/chargeback',$3,'OPEN') RETURNING id`, [t, refundId, fixed(remaining)])).rows[0].id;
    chargebackInstallmentId = (await c.query(
      `INSERT INTO obligation_installments (tenant_id, obligation_id, installment_number, total_installments, gross_amount,
          net_expected_amount, due_date, original_expected_settlement_date, current_expected_settlement_date, status)
       VALUES ($1,$2,1,1,$3,$3,$4,$4,$4,'OPEN') RETURNING id`, [t, obligation, fixed(remaining), input.date])).rows[0].id;
  }
  return { id: refundId, cancelledAmount: fixed(dec(input.amount).minus(remaining)), chargebackInstallmentId };
}
