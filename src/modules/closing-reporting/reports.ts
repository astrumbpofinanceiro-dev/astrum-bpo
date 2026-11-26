/** Três visões e indicadores (Doc 3 §4). Tudo calculado em NUMERIC no banco. */
import type pg from "pg";
import { Decimal } from "decimal.js";
import { forbidden } from "../../shared/errors";

const APPROVED = "('APPROVED_FOR_LEDGER','LOCKED_IN_CLOSING')";

export function monthRange(month: string): [string, string] {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return [`${month}-01`, new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)];
}

const f = (v: Decimal) => v.toFixed(2);
const d = (v: string) => new Decimal(v);

export async function competenceReport(c: pg.PoolClient, tenantId: string, month: string) {
  const [from, to] = monthRange(month);
  const v = (await c.query(
    `SELECT
       COALESCE(SUM(gross_amount) FILTER (WHERE operation_type IN ('SALE','SERVICE')),0)::numeric(15,2) AS "grossRevenue",
       COALESCE(SUM(gross_amount) FILTER (WHERE operation_type = 'REFUND_REVERSAL'),0)::numeric(15,2) AS deductions,
       COALESCE(SUM(gross_amount) FILTER (WHERE operation_type IN ('PURCHASE','EXPENSE')),0)::numeric(15,2) AS "costsAndExpenses",
       COALESCE(SUM(gross_amount) FILTER (WHERE operation_type = 'SALE' AND acquirer_id IS NOT NULL),0)::numeric(15,2) AS "cardGross"
      FROM economic_operations WHERE tenant_id = $1 AND competence_date BETWEEN $2 AND $3
       AND deleted_at IS NULL AND review_status IN ${APPROVED}`, [tenantId, from, to])).rows[0];
  const fees = (await c.query(
    // CHARGEBACK já é dedução; não entra como taxa.
    `SELECT COALESCE(SUM(i.amount),0)::numeric(15,2) AS total,
            COALESCE(SUM(i.amount) FILTER (WHERE i.fee_type IN ('MDR','ANTICIPATION_FEE')),0)::numeric(15,2) AS card
       FROM settlement_fee_items i JOIN settlement_events e ON e.id = i.settlement_event_id AND e.status = 'ACTIVE'
      WHERE i.tenant_id = $1 AND i.fee_type <> 'CHARGEBACK'
        AND COALESCE(i.competence_date, e.settlement_date) BETWEEN $2 AND $3`, [tenantId, from, to])).rows[0];
  const charges = (await c.query(
    `SELECT COALESCE(SUM(ch.amount) FILTER (WHERE o.direction = 'RECEIVABLE'),0)::numeric(15,2) AS received,
            COALESCE(SUM(ch.amount) FILTER (WHERE o.direction = 'PAYABLE'),0)::numeric(15,2) AS paid
       FROM installment_charges ch
       JOIN reconciliation_groups g ON g.id = ch.reconciliation_group_id AND g.status = 'ACTIVE'
       JOIN obligation_installments i ON i.id = ch.installment_id
       JOIN financial_obligations o ON o.id = i.obligation_id
      WHERE ch.tenant_id = $1 AND ch.competence_date BETWEEN $2 AND $3`, [tenantId, from, to])).rows[0];
  return {
    grossRevenue: v.grossRevenue, deductions: v.deductions, costsAndExpenses: v.costsAndExpenses,
    financialFees: fees.total,
    operatingResult: f(d(v.grossRevenue).minus(v.deductions).minus(v.costsAndExpenses).minus(fees.total)),
    cardGross: v.cardGross, cardFees: fees.card,
    // Fora da fórmula do Doc 3 §4.1; mostrados à parte (D9).
    interestAndFinesReceived: charges.received, interestAndFinesPaid: charges.paid,
  };
}

/** Movimentos de caixa e banco; "transfer" marca pernas de transferência interna. */
const MOVEMENTS = `
  WITH legs AS (
    SELECT outflow_bank_tx_id AS id FROM internal_transfers WHERE tenant_id = $1 AND outflow_bank_tx_id IS NOT NULL
    UNION SELECT inflow_bank_tx_id FROM internal_transfers WHERE tenant_id = $1 AND inflow_bank_tx_id IS NOT NULL
  ), movements AS (
    SELECT financial_account_id AS account, bank_posting_date AS date,
           CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END AS value, id IN (SELECT id FROM legs) AS transfer
      FROM bank_transactions WHERE tenant_id = $1
    UNION ALL
    SELECT financial_account_id, transaction_date, CASE direction WHEN 'INFLOW' THEN amount ELSE -amount END, false
      FROM cash_transactions WHERE tenant_id = $1 AND deleted_at IS NULL AND review_status IN ${APPROVED}
    UNION ALL
    -- perna em caixa físico não tem extrato: vem da própria transferência
    SELECT a.id, t.transfer_date, CASE WHEN a.id = t.from_account_id THEN -t.amount ELSE t.amount END, true
      FROM internal_transfers t JOIN financial_accounts a
        ON a.id IN (t.from_account_id, t.to_account_id) AND a.account_type = 'CASH_PHYSICAL'
     WHERE t.tenant_id = $1
  )`;

export async function cashReport(c: pg.PoolClient, tenantId: string, month: string) {
  const [from, to] = monthRange(month);
  const accounts = (await c.query(
    `${MOVEMENTS}
     SELECT a.id, a.name, a.account_type, a.balance_validated_at IS NOT NULL AS validated,
       (a.initial_balance + COALESCE(SUM(m.value) FILTER (WHERE m.date < $2),0))::numeric(15,2) AS opening,
       COALESCE(SUM(m.value) FILTER (WHERE m.date BETWEEN $2 AND $3 AND m.value > 0 AND NOT m.transfer),0)::numeric(15,2) AS inflows,
       COALESCE(-SUM(m.value) FILTER (WHERE m.date BETWEEN $2 AND $3 AND m.value < 0 AND NOT m.transfer),0)::numeric(15,2) AS outflows,
       COALESCE(SUM(m.value) FILTER (WHERE m.date BETWEEN $2 AND $3 AND m.transfer),0)::numeric(15,2) AS transfers,
       (a.initial_balance + COALESCE(SUM(m.value) FILTER (WHERE m.date <= $3),0))::numeric(15,2) AS closing
      FROM financial_accounts a
      LEFT JOIN movements m ON m.account = a.id AND m.date >= a.initial_balance_date
     WHERE a.tenant_id = $1 AND a.is_active AND a.account_type <> 'CORPORATE_CARD' AND a.initial_balance_date <= $3
     GROUP BY a.id ORDER BY a.name`, [tenantId, from, to])).rows;
  const sum = (key: string) => f(accounts.reduce((acc, a) => acc.plus(a[key]), new Decimal(0)));
  return {
    inflows: sum("inflows"), outflows: sum("outflows"), netCashFlow: f(d(sum("inflows")).minus(sum("outflows"))),
    transfers: sum("transfers"), openingBalance: sum("opening"), closingBalance: sum("closing"), accounts,
  };
}

/** Fluxo previsto a partir de uma data. Parcelas liquidadas ou antecipadas nunca entram. */
export async function forecastReport(c: pg.PoolClient, tenantId: string, from: string) {
  const rows = (await c.query(
    `SELECT o.direction,
            CASE o.direction WHEN 'RECEIVABLE' THEN i.current_expected_settlement_date ELSE i.due_date END AS date,
            SUM(i.gross_amount - i.settled_amount - i.cancelled_amount)::numeric(15,2) AS amount
       FROM obligation_installments i JOIN financial_obligations o ON o.id = i.obligation_id
       LEFT JOIN economic_operations p ON p.id = o.economic_operation_id
      WHERE i.tenant_id = $1 AND i.status IN ('OPEN','PARTIALLY_SETTLED','OVERDUE')
        AND COALESCE(p.review_status, '') <> 'REJECTED' AND p.deleted_at IS NULL
      GROUP BY 1, 2 ORDER BY 2, 1`, [tenantId])).rows;
  const total = (direction: string, overdue: boolean) => f(rows
    .filter((r) => r.direction === direction && (r.date < from) === overdue)
    .reduce((acc, r) => acc.plus(r.amount), new Decimal(0)));
  return {
    from, receivables: total("RECEIVABLE", false), payables: total("PAYABLE", false),
    overdueReceivables: total("RECEIVABLE", true), overduePayables: total("PAYABLE", true),
    schedule: rows.filter((r) => r.date >= from),
  };
}

export type Quality = "COMPLETE" | "PARTIAL" | "UNAVAILABLE";

/** Fontes que faltam no mês, para o status de qualidade. */
async function sources(c: pg.PoolClient, tenantId: string, month: string) {
  const [from, to] = monthRange(month);
  const row = (await c.query(
    `SELECT
      EXISTS (SELECT 1 FROM financial_accounts a WHERE a.tenant_id = $1 AND a.is_active
               AND a.account_type <> 'CORPORATE_CARD' AND a.balance_validated_at IS NULL) AS "unvalidatedBalance",
      EXISTS (SELECT 1 FROM financial_accounts a WHERE a.tenant_id = $1 AND a.is_active AND a.account_type = 'BANK_CHECKING'
               AND NOT EXISTS (SELECT 1 FROM import_batches b WHERE b.financial_account_id = a.id
                     AND b.status IN ('IMPORTED_COMPLETE','IMPORTED_WITH_EXCEPTIONS','PARTIALLY_IMPORTED','DUPLICATE_FILE')
                     AND b.period_start <= $3 AND b.period_end >= $2)) AS "missingStatement",
      EXISTS (SELECT 1 FROM routine_items i JOIN client_routines r ON r.id = i.routine_id
               WHERE i.tenant_id = $1 AND i.competence_date = $2 AND i.status IN ('PENDING','OVERDUE')
                 AND r.expected_source_type = 'ACQUIRER_REPORT') AS "missingAcquirer",
      EXISTS (SELECT 1 FROM blocking_issues WHERE tenant_id = $1 AND competence_date = $2
               AND severity <> 'INFO' AND status <> 'RESOLVED') AS "openIssues",
      EXISTS (SELECT 1 FROM economic_operations WHERE tenant_id = $1 AND competence_date BETWEEN $2 AND $3
               AND deleted_at IS NULL AND review_status IN ('SUBMITTED_PENDING_BPO','UNDER_BPO_REVIEW')) AS "pendingOperations"`,
    [tenantId, from, to])).rows[0];
  return row as Record<"unvalidatedBalance" | "missingStatement" | "missingAcquirer" | "openIssues" | "pendingOperations", boolean>;
}

export async function indicators(c: pg.PoolClient, tenantId: string, month: string, caveats = false) {
  const [, to] = monthRange(month);
  const competence = await competenceReport(c, tenantId, month);
  const cash = await cashReport(c, tenantId, month);
  const forecast = await forecastReport(c, tenantId, to);
  const s = await sources(c, tenantId, month);
  const quality = (unavailable: boolean): Quality =>
    unavailable ? "UNAVAILABLE" : s.openIssues || s.pendingOperations || caveats ? "PARTIAL" : "COMPLETE";
  const cardNet = f(d(competence.cardGross).minus(competence.cardFees));
  const noCard = d(competence.cardGross).isZero();
  const open = (direction: string) => f(d(direction === "R" ? forecast.receivables : forecast.payables)
    .plus(direction === "R" ? forecast.overdueReceivables : forecast.overduePayables));
  const make = (code: string, label: string, value: string | null, unavailable = false, unit = "BRL") =>
    ({ code, label, unit, quality: quality(unavailable), value: unavailable ? null : value });
  return [
    make("IND_GROSS_REVENUE", "Faturamento bruto", competence.grossRevenue),
    make("IND_NET_CARD_REVENUE", "Receita líquida de cartões", cardNet, s.missingAcquirer),
    make("IND_EFFECTIVE_CARD_FEE_RATE", "Taxa média efetiva de cartão",
      noCard ? null : f(d(competence.cardFees).dividedBy(competence.cardGross).times(100)), s.missingAcquirer || noCard, "%"),
    make("IND_OPERATING_RESULT", "Resultado operacional", competence.operatingResult),
    make("IND_CASH_FLOW_BALANCE", "Geração líquida de caixa", cash.netCashFlow, s.unvalidatedBalance || s.missingStatement),
    make("IND_OPEN_PAYABLES", "Contas a pagar em aberto", open("P")),
    make("IND_OPEN_RECEIVABLES", "Contas a receber em aberto", open("R")),
  ];
}

export async function fullReport(c: pg.PoolClient, tenantId: string, month: string, caveats = false) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw forbidden();
  const next = new Date(`${monthRange(month)[1]}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return {
    month,
    competence: await competenceReport(c, tenantId, month),
    cash: await cashReport(c, tenantId, month),
    forecast: await forecastReport(c, tenantId, next.toISOString().slice(0, 10)),
    indicators: await indicators(c, tenantId, month, caveats),
  };
}

/**
 * Resultado por etiqueta (contrato/turma), pela competência das operações aprovadas.
 * Sem mês, acumula todas as competências. Taxas de cartão e juros não são rateados por etiqueta;
 * por isso o total das etiquetas somado ao "sem etiqueta" fecha com receita e custos do relatório geral.
 */
export async function tagReport(c: pg.PoolClient, tenantId: string, month?: string) {
  const [from, to] = month ? monthRange(month) : ["0001-01-01", "9999-12-31"];
  const rows = (await c.query(
    `SELECT t.id AS "tagId", t.name, t.color,
            COUNT(o.id)::int AS operations,
            COALESCE(SUM(o.gross_amount) FILTER (WHERE o.operation_type IN ('SALE','SERVICE')),0)::numeric(15,2) AS revenue,
            COALESCE(SUM(o.gross_amount) FILTER (WHERE o.operation_type = 'REFUND_REVERSAL'),0)::numeric(15,2) AS deductions,
            COALESCE(SUM(o.gross_amount) FILTER (WHERE o.operation_type IN ('PURCHASE','EXPENSE')),0)::numeric(15,2) AS costs
       FROM tags t JOIN economic_operations o ON o.tenant_id = t.tenant_id AND o.tag_id = t.id
        AND o.competence_date BETWEEN $2 AND $3 AND o.deleted_at IS NULL AND o.review_status IN ${APPROVED}
      WHERE t.tenant_id = $1 GROUP BY t.id, t.name, t.color ORDER BY t.name`, [tenantId, from, to])).rows;
  const withResult = rows.map((r) => ({ ...r, result: f(d(r.revenue).minus(r.deductions).minus(r.costs)) }));
  const untagged = (await c.query(
    `SELECT COUNT(*)::int AS operations,
            COALESCE(SUM(gross_amount) FILTER (WHERE operation_type IN ('SALE','SERVICE')),0)::numeric(15,2) AS revenue,
            COALESCE(SUM(gross_amount) FILTER (WHERE operation_type = 'REFUND_REVERSAL'),0)::numeric(15,2) AS deductions,
            COALESCE(SUM(gross_amount) FILTER (WHERE operation_type IN ('PURCHASE','EXPENSE')),0)::numeric(15,2) AS costs
       FROM economic_operations WHERE tenant_id = $1 AND tag_id IS NULL AND competence_date BETWEEN $2 AND $3
        AND deleted_at IS NULL AND review_status IN ${APPROVED}`, [tenantId, from, to])).rows[0];
  return { month: month ?? null, tags: withResult,
    untagged: { ...untagged, result: f(d(untagged.revenue).minus(untagged.deductions).minus(untagged.costs)) } };
}
