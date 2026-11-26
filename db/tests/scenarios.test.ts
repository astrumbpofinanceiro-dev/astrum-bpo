/** Os 10 cenários de aceite do Documento 3 §7, cada um em um banco limpo. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as tenantRoute from "../../src/app/api/tenants/[tenantId]/route.ts";
import * as entries from "../../src/app/api/tenants/[tenantId]/entries/route.ts";
import * as entry from "../../src/app/api/tenants/[tenantId]/entries/[entryId]/route.ts";
import * as balances from "../../src/app/api/tenants/[tenantId]/balances/route.ts";
import * as reports from "../../src/app/api/tenants/[tenantId]/reports/route.ts";
import * as operations from "../../src/app/api/tenants/[tenantId]/operations/route.ts";
import * as approve from "../../src/app/api/tenants/[tenantId]/operations/approve/route.ts";
import * as refunds from "../../src/app/api/tenants/[tenantId]/operations/[operationId]/refunds/route.ts";
import * as settlements from "../../src/app/api/tenants/[tenantId]/settlements/route.ts";
import * as anticipations from "../../src/app/api/tenants/[tenantId]/anticipations/route.ts";
import * as anticipationReverse from "../../src/app/api/tenants/[tenantId]/anticipations/[anticipationId]/reverse/route.ts";
import * as suggest from "../../src/app/api/tenants/[tenantId]/reconciliations/suggestions/route.ts";
import * as reconciliations from "../../src/app/api/tenants/[tenantId]/reconciliations/route.ts";
import * as transfers from "../../src/app/api/tenants/[tenantId]/transfers/route.ts";
import * as batches from "../../src/app/api/tenants/[tenantId]/batches/[batchId]/route.ts";
import * as apply from "../../src/app/api/tenants/[tenantId]/batches/[batchId]/apply/route.ts";
import * as issues from "../../src/app/api/tenants/[tenantId]/issues/route.ts";
import * as respond from "../../src/app/api/tenants/[tenantId]/issues/[issueId]/respond/route.ts";
import * as validate from "../../src/app/api/tenants/[tenantId]/issues/[issueId]/validate/route.ts";
import * as closing from "../../src/app/api/tenants/[tenantId]/closing/route.ts";
import * as reopen from "../../src/app/api/tenants/[tenantId]/closing/reopen/route.ts";
import * as version from "../../src/app/api/tenants/[tenantId]/closing-versions/[versionId]/route.ts";
import * as validateBalance from "../../src/app/api/tenants/[tenantId]/balance-validations/[accountId]/route.ts";
import { insert, operation } from "./helpers.ts";
import { ofx, testApp, type App, type Tx } from "./app.ts";

const WHY = "motivo detalhado exigido pelo teste";

describe("Documento 3 §7 — cenários obrigatórios", () => {
  let app: App;
  beforeEach(async () => { app = await testApp(); });
  afterEach(async () => { await app.close(); });

  const report = (m: string) => app.ok(reports.GET, app.s.user, { query: `?month=${m}` });
  const post = (handler: Parameters<App["ok"]>[0], body: unknown, params?: Record<string, string>, user = app.s.user) =>
    app.ok(handler, user, { body, params });
  const create = (operationType: string, date: string, amount: string, dues: string[], extra: object = {}) =>
    post(operations.POST, { operationType, operationDate: date, grossAmount: amount, description: "Documento",
      installments: dues.map((dueDate) => ({ dueDate })), ...extra });
  const sale = (date: string, amount: string, dues: string[], extra: object = {}) =>
    create("SALE", date, amount, dues, { acquirerId: app.s.a.acquirer, ...extra });
  const approved = (...ops: { id: string }[]) => post(approve.POST, { operationIds: ops.map((o) => o.id) }, undefined, app.s.reviewer);
  const card = () => ({ financialAccountId: app.s.a.bankA, acquirerId: app.s.a.acquirer });
  const to = (movementId: string, targetType: string, targetId: string, amount: string) =>
    ({ movementType: "BANK_TRANSACTION", movementId, targetType, targetId, amount });
  const reconcile = (...allocations: object[]) => post(reconciliations.POST, { allocations });
  const parcels = (operationId: string) => app.rows(
    `SELECT i.status, i.original_expected_settlement_date AS original FROM obligation_installments i
       JOIN financial_obligations o ON o.id = i.obligation_id WHERE o.economic_operation_id = $1 ORDER BY i.installment_number`, operationId);
  const validateBalances = async () => {
    for (const accountId of [app.s.a.bankA, app.s.a.bankB]) {
      await app.ok(validateBalance.POST, app.s.reviewer, { method: "POST", params: { accountId } });
    }
  };
  const publish = (caveats?: object) => app.call(closing.POST, app.s.reviewer, { body: { month: "2026-11", ...(caveats && { caveats }) } });
  const openIssue = async (targetType: string, targetId: string, side = "CLIENT") => (await post(issues.POST, {
    competenceDate: "2026-11-01", targetType, targetId, severity: "BLOCKING_OPERATIONAL", title: "Sem comprovante",
    description: "Enviar o comprovante", assignedToSide: side })).id as string;

  it("1 — isolamento multi-tenant e Modo Cego", async () => {
    const { s, ids } = app;
    const c = await app.db.admin.connect();
    let own = "", otherUnit = "";
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.current_user_id',$1,true), set_config('app.actor_role','SYSTEM_WORKER',true)", [s.user]);
      const op = (user: string, unit: string) => insert(c, "economic_operations", operation(s.a, user, "10.00", { business_unit_id: unit }));
      own = await op(ids.employee, s.a.unit);
      await op(ids.owner, s.a.unit);
      otherUnit = await op(ids.owner, ids.unit2);
      await c.query("COMMIT");
    } finally {
      c.release();
    }
    const x = ids.employee;
    expect((await app.call(tenantRoute.GET, x, { tenant: s.b.id })).status).toBe(403);
    expect((await app.call(entries.GET, x, { tenant: s.b.id })).status).toBe(403);
    expect((await app.call(balances.GET, x)).status).toBe(403);
    expect((await app.call(entries.GET, x, { query: `?businessUnitId=${ids.unit2}` })).status).toBe(403);
    expect((await app.call(entry.GET, x, { params: { entryId: otherUnit } })).status).toBe(403);
    expect((await app.ok(entries.GET, x)).map((e: { id: string }) => e.id)).toEqual([own]);
  });

  it("2 — upload duplicado e sobreposição de lotes", async () => {
    const { s } = app;
    const first: Tx[] = [["2026-11-01", "100.00", "A1"], ["2026-11-15", "-40.00", "A2"]];
    const full: Tx[] = [...first, ["2026-11-16", "70.00", "A3"], ["2026-11-30", "-10.00", "A4"]];
    const send = async (name: string, content: string) => {
      const r = await app.upload(s.user, name, content, { docCategory: "BANK_STATEMENT", financialAccountId: s.a.bankA });
      await app.work();
      return app.ok(batches.GET, s.user, { params: { batchId: r.batchId! } });
    };
    const total = async () => (await app.rows("SELECT count(*)::int AS n FROM bank_transactions"))[0].n;
    const file = ofx("2026-11-01", "2026-11-15", first);

    expect((await send("quinzena.ofx", file)).status).toBe("IMPORTED_COMPLETE");
    expect(await total()).toBe(2);
    expect((await send("quinzena.ofx", file)).status).toBe("DUPLICATE_FILE");
    expect(await total()).toBe(2);

    const month = await send("mes.ofx", ofx("2026-11-01", "2026-11-30", full));
    expect(month).toMatchObject({ total_items: 4, imported_items: 2, duplicate_items: 2 });
    expect(await app.rows("SELECT external_fitid AS f FROM bank_transactions ORDER BY 1"))
      .toEqual(["A1", "A2", "A3", "A4"].map((f) => ({ f })));
  });

  it("3 — competência vs. caixa", async () => {
    const purchase = await create("PURCHASE", "2026-11-28", "1200.00", ["2026-12-05"]);
    await approved(purchase);
    let november = await report("2026-11");
    expect(november.competence.costsAndExpenses).toBe("1200.00");
    expect(november.forecast.schedule).toEqual([{ direction: "PAYABLE", date: "2026-12-05", amount: "1200.00" }]);

    const [debit] = await app.statement([["2026-12-05", "-1200.00", "C3"]]);
    await reconcile(to(debit!, "OBLIGATION_INSTALLMENT", purchase.installmentIds[0], "1200.00"));
    november = await report("2026-11");
    expect(november.cash).toMatchObject({ inflows: "0.00", outflows: "0.00", netCashFlow: "0.00" });
    expect((await report("2026-12")).cash.netCashFlow).toBe("-1200.00");
    expect((await report("2026-12")).competence.costsAndExpenses).toBe("0.00");
  });

  it("4 — antecipação total em mês anterior", async () => {
    const v = await sale("2026-11-25", "5000.00", ["2026-12-25"], { expectedFeeAmount: "100.00" });
    await approved(v);
    const a = await post(anticipations.POST, { ...card(), requestedAt: "2026-11-27", effectiveDate: "2026-11-27",
      items: [{ installmentId: v.installmentIds[0], grossAmount: "5000.00", mdrFee: "100.00", anticipationFee: "50.00" }] });
    const [credit] = await app.statement([["2026-11-28", "4850.00", "C4"]]);
    await reconcile(to(credit!, "SETTLEMENT_EVENT", a.settlementId, "4850.00"));

    const november = await report("2026-11");
    expect(november.competence).toMatchObject({ grossRevenue: "5000.00", financialFees: "150.00" });
    expect(november.cash.inflows).toBe("4850.00");
    expect(november.forecast).toMatchObject({ receivables: "0.00", schedule: [] }); // a partir de 01/12
    expect(await app.rows("SELECT bank_posting_date AS d, amount FROM bank_transactions"))
      .toEqual([{ d: "2026-11-28", amount: "4850.00" }]);
    expect(await parcels(v.id)).toEqual([{ status: "ANTICIPATED_SETTLED", original: "2026-12-25" }]);
  });

  it("5 — antecipação parcial de parcelas", async () => {
    const v = await sale("2026-11-10", "3000.00", ["2026-12-10", "2027-01-10", "2027-02-10"]);
    await approved(v);
    await post(anticipations.POST, { ...card(), requestedAt: "2026-11-20", effectiveDate: "2026-11-20",
      items: [{ installmentId: v.installmentIds[0], grossAmount: "1000.00" }] });
    expect((await parcels(v.id)).map((p) => p.status)).toEqual(["ANTICIPATED_SETTLED", "OPEN", "OPEN"]);
    expect((await report("2026-11")).forecast.schedule).toEqual([
      { direction: "RECEIVABLE", date: "2027-01-10", amount: "1000.00" },
      { direction: "RECEIVABLE", date: "2027-02-10", amount: "1000.00" },
    ]);
  });

  const threeSales = async () => {
    const out = [];
    for (const value of ["300.00", "450.00", "250.00"]) out.push({ value, ...(await sale("2026-11-25", value, ["2026-12-25"])) });
    await approved(...out);
    return out;
  };
  const group = async () => app.rows(
    `SELECT count(DISTINCT group_id)::int AS groups, count(*)::int AS allocations, sum(allocated_amount)::text AS total
       FROM reconciliation_allocations`);

  it("6 — conciliação N:1, um repasse por venda", async () => {
    const sales = await threeSales();
    const events = [];
    for (const v of sales) {
      events.push({ value: v.value, ...(await post(settlements.POST, { ...card(), settlementDate: "2026-11-28",
        items: [{ installmentId: v.installmentIds[0], grossAmount: v.value }] })) });
    }
    const [credit] = await app.statement([["2026-11-28", "1000.00", "C6"]]);
    await reconcile(...events.map((e) => to(credit!, "SETTLEMENT_EVENT", e.id, e.value)));
    expect(await group()).toEqual([{ groups: 1, allocations: 3, total: "1000.00" }]);
    expect((await app.rows("SELECT reconciliation_status AS v FROM bank_transactions"))[0].v).toBe("RECONCILED");
    expect((await report("2026-11")).competence.grossRevenue).toBe("1000.00");
  });

  const importedThree = async (nets: [string, string, string] = ["300,00", "450,00", "250,00"]) => {
    const csv = ["external_nsu_tid;operation_date;installment_number;total_installments;gross_amount;mdr_fee_amount;anticipation_fee_amount;net_amount;expected_settlement_date;settlement_date;event_type",
      ...[["1", "300,00", nets[0]], ["2", "450,00", nets[1]], ["3", "250,00", nets[2]]].flatMap(([n, v, net]) => [
        `N${n};2026-11-25;1;1;${v};0;0;${v};2026-12-25;;SALE`,
        `N${n};2026-11-25;1;1;${v};0;0;${net};;2026-11-28;SETTLEMENT`])].join("\n");
    const upload = await app.upload(app.s.user, "lote.csv", csv, { docCategory: "ACQUIRER_REPORT", acquirerId: app.s.a.acquirer });
    await app.work();
    return post(apply.POST, {}, { batchId: upload.batchId! });
  };

  it("6 — mesmas vendas em um lote único importado: um evento por venda, 1 repasse com 3 alocações", async () => {
    expect(await importedThree()).toMatchObject({ applied: 6, pending: 0 });
    expect((await app.rows("SELECT count(*)::int AS n FROM settlement_events"))[0].n).toBe(3);
    const [credit] = await app.statement([["2026-11-28", "1000.00", "C6L"]]);
    // a sugestão automática soma os eventos da mesma conta e data
    const suggestions = await app.ok(suggest.POST, app.s.user, { method: "POST" });
    const mine = suggestions.find((x: { movementId: string }) => x.movementId === credit);
    expect(mine.combinations).toHaveLength(1);
    expect(mine.combinations[0].targets).toHaveLength(3);
    const events = await app.rows("SELECT id, net_amount FROM settlement_events ORDER BY net_amount");
    await reconcile(...events.map((e: { id: string; net_amount: string }) => to(credit!, "SETTLEMENT_EVENT", e.id, e.net_amount)));
    expect(await group()).toEqual([{ groups: 1, allocations: 3, total: "1000.00" }]);
    expect((await app.rows("SELECT reconciliation_status AS v FROM bank_transactions"))[0].v).toBe("RECONCILED");
    expect((await app.rows("SELECT count(*)::int AS n FROM settlement_allocations"))[0].n).toBe(3);
  });

  it("6 — antecipação importada: uma antecipação, um evento por venda, estorno desfaz todos", async () => {
    const csv = ["external_nsu_tid;operation_date;installment_number;total_installments;gross_amount;mdr_fee_amount;anticipation_fee_amount;net_amount;expected_settlement_date;settlement_date;event_type",
      ...[["1", "300,00", "5,00", "295,00"], ["2", "200,00", "4,00", "196,00"]].flatMap(([n, v, fee, net]) => [
        `N${n};2026-11-25;1;1;${v};0;${fee};${net};2026-12-25;;SALE`,
        `N${n};2026-11-25;1;1;${v};0;${fee};${net};;2026-11-28;ANTICIPATION`])].join("\n");
    const upload = await app.upload(app.s.user, "ant.csv", csv, { docCategory: "ACQUIRER_REPORT", acquirerId: app.s.a.acquirer });
    await app.work();
    expect(await post(apply.POST, {}, { batchId: upload.batchId! })).toMatchObject({ applied: 4, pending: 0 });
    expect((await app.rows("SELECT count(*)::int AS n FROM receivable_anticipations"))[0].n).toBe(1);
    expect(await app.rows("SELECT net_amount FROM settlement_events WHERE anticipation_id IS NOT NULL ORDER BY net_amount"))
      .toEqual([{ net_amount: "196.00" }, { net_amount: "295.00" }]);
    const [a] = await app.rows("SELECT id FROM receivable_anticipations");
    await app.ok(anticipationReverse.POST, app.s.reviewer, { params: { anticipationId: a.id }, body: { reason: WHY } });
    expect(await app.rows("SELECT DISTINCT status FROM settlement_events")).toEqual([{ status: "REVERSED" }]);
  });

  it("6 — centavos de ajuste ficam no evento da própria venda", async () => {
    expect(await importedThree(["300,00", "449,99", "250,00"])).toMatchObject({ applied: 6, pending: 0 });
    const adjusted = await app.rows(
      `SELECT e.net_amount, f.amount FROM settlement_fee_items f JOIN settlement_events e ON e.id = f.settlement_event_id
        WHERE f.fee_type = 'ADJUSTMENT'`);
    expect(adjusted).toEqual([{ net_amount: "449.99", amount: "0.01" }]);
  });

  it("7 — chargeback após liquidação", async () => {
    const v = await sale("2026-11-10", "800.00", ["2026-11-12"]);
    await approved(v);
    const e = await post(settlements.POST, { ...card(), settlementDate: "2026-11-12",
      items: [{ installmentId: v.installmentIds[0], grossAmount: "800.00" }] });
    const [credit] = await app.statement([["2026-11-12", "800.00", "C7a"]]);
    await reconcile(to(credit!, "SETTLEMENT_EVENT", e.id, "800.00"));
    const original = await app.rows("SELECT * FROM economic_operations WHERE id = $1", v.id);

    const r = await post(refunds.POST, { amount: "800.00", date: "2026-11-20", reason: WHY }, { operationId: v.id }, app.s.reviewer);
    expect(await app.rows("SELECT * FROM economic_operations WHERE id = $1", v.id)).toEqual(original);
    expect(await app.rows("SELECT gross_amount AS g FROM economic_operations WHERE operation_type = 'REFUND_REVERSAL'"))
      .toEqual([{ g: "800.00" }]);
    // o caixa só muda quando o débito acontece de fato
    expect((await report("2026-11")).cash.outflows).toBe("0.00");
    const [debit] = await app.statement([["2026-11-25", "-800.00", "C7b"]]);
    await reconcile(to(debit!, "OBLIGATION_INSTALLMENT", r.chargebackInstallmentId, "800.00"));
    const november = await report("2026-11");
    expect(november.cash).toMatchObject({ inflows: "800.00", outflows: "800.00", netCashFlow: "0.00" });
    expect(november.competence).toMatchObject({ grossRevenue: "800.00", deductions: "800.00", operatingResult: "0.00" });
  });

  it("8 — transferência interna entre contas", async () => {
    const before = await report("2026-11");
    const [out] = await app.statement([["2026-11-20", "-2000.00", "C8a"]]);
    const [inn] = await app.statement([["2026-11-20", "2000.00", "C8b"]], app.s.a.bankB);
    await post(transfers.POST, { fromAccountId: app.s.a.bankA, toAccountId: app.s.a.bankB, date: "2026-11-20",
      amount: "2000.00", outflowBankTxId: out, inflowBankTxId: inn });
    const after = await report("2026-11");
    const closingOf = (id: string) => after.cash.accounts.find((a: { id: string }) => a.id === id).closing;
    expect(closingOf(app.s.a.bankA)).toBe("-2000.00");
    expect(closingOf(app.s.a.bankB)).toBe("2000.00");
    expect(after.competence).toEqual(before.competence);
    expect(after.cash).toMatchObject({ inflows: "0.00", outflows: "0.00" });
  });

  it("9 — pendência bloqueante e resposta do cliente", async () => {
    await validateBalances();
    const expense = await create("EXPENSE", "2026-11-20", "2500.00", ["2026-11-20"]);
    await approved(expense);
    const [debit] = await app.statement([["2026-11-20", "-2500.00", "C9"]]);
    await reconcile(to(debit!, "OBLIGATION_INSTALLMENT", expense.installmentIds[0], "2500.00"));
    const issue = await openIssue("BANK_TRANSACTION", debit!);

    const receipt = await app.upload(app.ids.owner, "comprovante.pdf", "%PDF-1.4\n%%EOF", { docCategory: "RECEIPT" });
    await post(respond.POST, { text: "Segue o comprovante", documentId: receipt.id }, { issueId: issue }, app.ids.owner);
    const status = async () => (await app.rows("SELECT status FROM blocking_issues WHERE id = $1", issue))[0].status;
    expect(await status()).toBe("ANSWERED_PENDING_BPO_VALIDATION");
    expect((await publish()).body.error).toBe("CHECKLIST_NO_BLOCKING");
    const caveats = { justification: WHY, reviewDeadline: "2026-12-15", responsibleUserId: app.s.reviewer, issueIds: [issue] };
    expect((await publish(caveats)).body.error).toBe("CAVEAT_ISSUE_AWAITING_VALIDATION");

    await post(validate.POST, { decision: "ACCEPT", reason: "comprovante confere" }, { issueId: issue }, app.s.reviewer);
    expect(await status()).toBe("RESOLVED");
    expect((await publish()).body).toMatchObject({ version: 1, closingType: "PUBLISHED_FULL" });
  });

  it("10 — fechamento versionado, ressalva e reabertura", async () => {
    await validateBalances();
    const v = await sale("2026-11-10", "900.00", ["2026-12-10"]);
    await approved(v);
    const issue = await openIssue("OPERATION", v.id, "BPO");
    const first = await publish({ justification: WHY, reviewDeadline: "2026-12-15", responsibleUserId: app.s.reviewer, issueIds: [issue] });
    expect(first.body).toMatchObject({ version: 1, closingType: "PUBLISHED_WITH_CAVEATS" });
    const read = async (id: string) => (await app.ok(version.GET, app.s.reviewer, { params: { versionId: id } }));
    const published = await read(first.body.id);

    await post(reopen.POST, { month: "2026-11", reason: WHY }, undefined, app.s.reviewer);
    await approved(await create("EXPENSE", "2026-11-28", "100.00", ["2026-12-05"]));
    const second = await publish();
    expect(second.body).toMatchObject({ version: 2, closingType: "PUBLISHED_FULL" });

    const old = await read(first.body.id);
    expect(old.status).toBe("SUPERSEDED");
    expect(old.snapshot).toEqual(published.snapshot);
    expect(old.snapshot.competence.operatingResult).toBe("900.00");
    expect(await read(second.body.id)).toMatchObject({ status: "ACTIVE", snapshot: { competence: { operatingResult: "800.00" } } });

    const trail = await app.rows(
      `SELECT entity_type, count(*)::int AS n, bool_and(actor_user_id IS NOT NULL) AS actor FROM audit_logs
        WHERE entity_type IN ('closing_versions','period_closings','closing_version_issues') GROUP BY 1 ORDER BY 1`);
    expect(trail.map((t) => [t.entity_type, t.actor])).toEqual(
      [["closing_version_issues", true], ["closing_versions", true], ["period_closings", true]]);
    expect(trail.find((t) => t.entity_type === "closing_versions")!.n).toBe(3); // v1, v1 substituída, v2
    const states = await app.rows(
      `SELECT new_values->>'status' AS s FROM audit_logs WHERE entity_type = 'period_closings' ORDER BY created_at, id`);
    expect(states.map((x) => x.s)).toEqual(expect.arrayContaining(
      ["BLOCKED_BY_ISSUES", "CLOSED_WITH_CAVEATS", "REOPENED", "READY_FOR_REVIEW", "CLOSED_PUBLISHED"]));
  });
});
