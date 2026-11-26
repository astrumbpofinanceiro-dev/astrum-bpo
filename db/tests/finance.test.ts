/** Etapa 4: rotas reais. Cenários 3 a 8 do Documento 3 e decisões D7 a D10. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setDeps } from "../../src/server/container.ts";
import { processNext } from "../../src/modules/import-processing/worker.ts";
import type { FileStorage } from "../../src/modules/document-intake/storage.ts";
import * as documentsRoute from "../../src/app/api/tenants/[tenantId]/documents/route.ts";
import * as operationsRoute from "../../src/app/api/tenants/[tenantId]/operations/route.ts";
import * as operationRoute from "../../src/app/api/tenants/[tenantId]/operations/[operationId]/route.ts";
import * as approveRoute from "../../src/app/api/tenants/[tenantId]/operations/approve/route.ts";
import * as rejectRoute from "../../src/app/api/tenants/[tenantId]/operations/[operationId]/reject/route.ts";
import * as refundRoute from "../../src/app/api/tenants/[tenantId]/operations/[operationId]/refunds/route.ts";
import * as settlementsRoute from "../../src/app/api/tenants/[tenantId]/settlements/route.ts";
import * as settlementReverse from "../../src/app/api/tenants/[tenantId]/settlements/[settlementId]/reverse/route.ts";
import * as anticipationsRoute from "../../src/app/api/tenants/[tenantId]/anticipations/route.ts";
import * as anticipationReverse from "../../src/app/api/tenants/[tenantId]/anticipations/[anticipationId]/reverse/route.ts";
import * as applyRoute from "../../src/app/api/tenants/[tenantId]/batches/[batchId]/apply/route.ts";
import * as reconcileRoute from "../../src/app/api/tenants/[tenantId]/reconciliations/route.ts";
import * as reconcileReverse from "../../src/app/api/tenants/[tenantId]/reconciliations/[groupId]/reverse/route.ts";
import * as suggestRoute from "../../src/app/api/tenants/[tenantId]/reconciliations/suggestions/route.ts";
import * as transfersRoute from "../../src/app/api/tenants/[tenantId]/transfers/route.ts";
import { as, bankTx, createTestDb, ctx, insert, seed, type Seed, type TestDb } from "./helpers.ts";

type Handler = (r: Request, s?: { params: Promise<Record<string, string>> }) => Promise<Response>;
const objects = new Map<string, Buffer>();
const storage: FileStorage = {
  bucket: "documents", async put(k, b) { objects.set(k, b); }, async get(k) { return objects.get(k)!; },
  async signedUrl() { return ""; }, async remove() {},
};
const WHY = "motivo de teste detalhado";

describe("motor financeiro e conciliação", () => {
  let db: TestDb;
  let s: Seed;

  async function call(handler: Handler, user: string, options: { params?: Record<string, string>; body?: unknown; form?: FormData } = {}) {
    const response = await handler(
      new Request("http://app.test/api", {
        method: options.body !== undefined || options.form || handler === applyRoute.POST || handler === suggestRoute.POST ? "POST" : "GET",
        headers: { origin: "http://app.test", "x-user": user },
        body: options.form ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
      }), { params: Promise.resolve({ tenantId: s.a.id, ...options.params }) });
    return { status: response.status, body: await response.json() };
  }
  const ok = async (handler: Handler, body?: unknown, params?: Record<string, string>, user = s.user) => {
    const r = await call(handler, user, { body, params });
    expect(r, JSON.stringify(r.body)).toMatchObject({ status: expect.any(Number) });
    expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
    return r.body;
  };
  const row = async (sql: string, ...values: unknown[]) => (await db.admin.query(sql, values)).rows[0];
  const parcel = (id: string) => row(
    `SELECT status, settled_amount, cancelled_amount, original_expected_settlement_date AS original,
            current_expected_settlement_date AS current FROM obligation_installments WHERE id=$1`, id);
  const bank = (amount: string, extra: Record<string, unknown> = {}) =>
    as(db, ctx(s.user, s.a.id), (c) => insert(c, "bank_transactions", bankTx(s.a, amount, extra)));
  const status = async (id: string) => (await row("SELECT reconciliation_status AS v FROM bank_transactions WHERE id=$1", id)).v;
  const alloc = (movementId: string, targetType: string, targetId: string, amount: string, extra: object = {}) =>
    ({ movementType: "BANK_TRANSACTION", movementId, targetType, targetId, amount, ...extra });

  const sale = (gross: string, dates: string[], extra: object = {}) => ok(operationsRoute.POST, {
    operationType: "SALE", operationDate: "2026-11-25", grossAmount: gross, description: "Venda", acquirerId: s.a.acquirer,
    installments: dates.map((dueDate) => ({ dueDate })), ...extra,
  });
  const base = () => ({ financialAccountId: s.a.bankA, acquirerId: s.a.acquirer });

  beforeAll(async () => {
    db = await createTestDb();
    s = await seed(db);
    setDeps({
      pool: db.app, appUrl: "http://app.test", storage,
      verifySession: async (r) => ({ userId: r.headers.get("x-user")!, aal: "aal2", hasVerifiedFactor: false }),
      identity: { async invite() { throw new Error("n/a"); }, async remove() {} },
    });
    const c = await db.admin.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.current_user_id',$1,true), set_config('app.actor_role','SYSTEM_WORKER',true)", [s.user]);
      for (const [user_id, bpo_role] of [[s.user, "BPO_ANALYST"], [s.reviewer, "BPO_REVIEWER"]]) {
        await insert(c, "bpo_staff_assignments", { user_id, tenant_id: s.a.id, bpo_role });
      }
      await c.query("COMMIT");
    } finally {
      c.release();
    }
  });
  afterAll(async () => { setDeps(undefined); await db.close(); });

  it("Cenário 3: despesa na competência de novembro, paga em dezembro", async () => {
    const op = await ok(operationsRoute.POST, { operationType: "PURCHASE", operationDate: "2026-11-28",
      grossAmount: "1200.00", description: "Nota de compra", installments: [{ dueDate: "2026-12-05" }] });
    expect((await parcel(op.installmentIds[0])).status).toBe("OPEN");
    const tx = await bank("1200.00", { direction: "DEBIT", bank_posting_date: "2026-12-05" });
    const suggestions = await ok(suggestRoute.POST);
    expect(suggestions).toContainEqual(expect.objectContaining({ movementId: tx, ambiguous: false }));
    expect(await status(tx)).toBe("SUGGESTED_MATCH");
    await ok(reconcileRoute.POST, { matchMethod: "EXACT_RULE", allocations: [alloc(tx, "OBLIGATION_INSTALLMENT", op.installmentIds[0], "1200.00")] });
    expect(await parcel(op.installmentIds[0])).toMatchObject({ status: "SETTLED", settled_amount: "1200.00" });
    expect(await status(tx)).toBe("RECONCILED");
    expect((await row("SELECT competence_date AS d FROM economic_operations WHERE id=$1", op.id)).d).toBe("2026-11-28");
  });

  it("Cenário 4: antecipação total, taxas em novembro e previsão original preservada; D10 desfaz", async () => {
    const v = await sale("5000.00", ["2026-12-25"], { expectedFeeAmount: "100.00" });
    const a = await ok(anticipationsRoute.POST, { ...base(), requestedAt: "2026-11-27", effectiveDate: "2026-11-27",
      items: [{ installmentId: v.installmentIds[0], grossAmount: "5000.00", mdrFee: "100.00", anticipationFee: "50.00" }] });
    expect(a.netAmount).toBe("4850.00");
    expect(await parcel(v.installmentIds[0])).toMatchObject(
      { status: "ANTICIPATED_SETTLED", original: "2026-12-25", current: "2026-11-27", settled_amount: "5000.00" });
    expect((await row(`SELECT sum(amount)::text AS v FROM settlement_fee_items WHERE settlement_event_id=$1
                        AND competence_date='2026-11-25'`, a.settlementId)).v).toBe("150.00");
    const credit = await bank("4850.00");
    const g = await ok(reconcileRoute.POST, { allocations: [alloc(credit, "SETTLEMENT_EVENT", a.settlementId, "4850.00")] });

    const undo = () => call(anticipationReverse.POST, s.reviewer, { params: { anticipationId: a.id }, body: { reason: WHY } });
    expect((await call(anticipationReverse.POST, s.user, { params: { anticipationId: a.id }, body: { reason: WHY } })).status).toBe(403);
    expect((await undo()).body.error).toBe("REVERSE_RECONCILIATION_FIRST");
    await ok(reconcileReverse.POST, { reason: WHY }, { groupId: g.id });
    expect((await undo()).status).toBe(201);
    expect(await parcel(v.installmentIds[0])).toMatchObject({ status: "OPEN", current: "2026-12-25", settled_amount: "0.00" });
    expect(await status(credit)).toBe("UNRECONCILED");
  });

  it("Cenário 5: antecipação parcial afeta só a parcela escolhida; não excede o saldo", async () => {
    const v = await sale("3000.00", ["2026-12-25", "2027-01-25", "2027-02-25"]);
    const antic = (grossAmount: string) => call(anticipationsRoute.POST, s.user, { body: { ...base(), requestedAt: "2026-11-27",
      effectiveDate: "2026-11-27", items: [{ installmentId: v.installmentIds[0], grossAmount }] } });
    expect((await antic("400.00")).status).toBe(201);
    expect(await parcel(v.installmentIds[0])).toMatchObject({ status: "PARTIALLY_SETTLED", current: "2026-12-25" });
    expect((await antic("700.00")).status).toBe(409);
    expect((await antic("600.00")).status).toBe(201);
    expect((await parcel(v.installmentIds[0])).status).toBe("ANTICIPATED_SETTLED");
    expect((await parcel(v.installmentIds[1])).status).toBe("OPEN");
    expect((await parcel(v.installmentIds[2])).status).toBe("OPEN");
  });

  it("Cenário 6: três vendas, um depósito; centavos viram ajuste", async () => {
    const allocations = [];
    const credit = await bank("1000.00");
    for (const value of ["300.00", "450.00", "250.00"]) {
      const v = await sale(value, ["2026-12-25"]);
      const e = await ok(settlementsRoute.POST, { ...base(), settlementDate: "2026-11-28",
        items: [{ installmentId: v.installmentIds[0], grossAmount: value }] });
      allocations.push(alloc(credit, "SETTLEMENT_EVENT", e.id, value));
    }
    await ok(reconcileRoute.POST, { allocations });
    expect(await status(credit)).toBe("RECONCILED");

    const v = await sale("100.00", ["2026-12-25"]);
    const e = await ok(settlementsRoute.POST, { ...base(), settlementDate: "2026-11-28",
      items: [{ installmentId: v.installmentIds[0], grossAmount: "100.00", mdrFee: "2.00" }] });
    const short = await bank("97.97");
    await ok(reconcileRoute.POST, { allocations: [alloc(short, "SETTLEMENT_EVENT", e.id, "97.97")] });
    expect(await row("SELECT amount::text AS v FROM settlement_fee_items WHERE settlement_event_id=$1 AND fee_type='ADJUSTMENT'", e.id))
      .toEqual({ v: "0.03" });
    expect(await status(short)).toBe("RECONCILED");
    // sem nenhuma outra taxa, o centavo também fica registrado
    const w = await sale("40.00", ["2026-12-25"]);
    const plain = await ok(settlementsRoute.POST, { ...base(), settlementDate: "2026-11-28",
      items: [{ installmentId: w.installmentIds[0], grossAmount: "40.00" }] });
    const less = await bank("39.99");
    await ok(reconcileRoute.POST, { allocations: [alloc(less, "SETTLEMENT_EVENT", plain.id, "39.99")] });
    expect(await row("SELECT amount::text AS v FROM settlement_fee_items WHERE settlement_event_id=$1", plain.id)).toEqual({ v: "0.01" });
    const far = await call(settlementsRoute.POST, s.user, { body: { ...base(), settlementDate: "2026-11-28", netAmount: "9.00",
      items: [{ installmentId: (await sale("10.00", ["2026-12-25"])).installmentIds[0], grossAmount: "10.00" }] } });
    expect(far.body.error).toBe("NET_AMOUNT_DIVERGES");
  });

  it("Cenário 7 e D8: chargeback após liquidação vira débito; parcela aberta é reduzida", async () => {
    const v = await sale("800.00", ["2026-11-27"]);
    const e = await ok(settlementsRoute.POST, { ...base(), settlementDate: "2026-11-27",
      items: [{ installmentId: v.installmentIds[0], grossAmount: "800.00" }] });
    const r = await ok(refundRoute.POST, { amount: "800.00", date: "2026-11-30", reason: WHY }, { operationId: v.id }, s.reviewer);
    expect(r).toMatchObject({ cancelledAmount: "0.00" });
    expect((await row("SELECT gross_amount AS g FROM economic_operations WHERE id=$1", v.id)).g).toBe("800.00");
    const other = await sale("900.00", ["2026-12-25"]);
    await ok(settlementsRoute.POST, { ...base(), settlementDate: "2026-12-01", netAmount: "100.00",
      items: [{ installmentId: other.installmentIds[0], grossAmount: "900.00" }],
      chargebacks: [{ installmentId: r.chargebackInstallmentId, amount: "800.00" }] });
    expect((await parcel(r.chargebackInstallmentId)).status).toBe("SETTLED");
    expect(e.netAmount).toBe("800.00");

    const open = await sale("300.00", ["2026-12-25", "2027-01-25", "2027-02-25"]);
    await ok(refundRoute.POST, { amount: "150.00", date: "2026-11-30", reason: WHY }, { operationId: open.id }, s.reviewer);
    expect(await parcel(open.installmentIds[2])).toMatchObject({ status: "CANCELLED", cancelled_amount: "100.00" });
    expect(await parcel(open.installmentIds[1])).toMatchObject({ status: "OPEN", cancelled_amount: "50.00" });
    const excess = await call(refundRoute.POST, s.reviewer, { params: { operationId: open.id }, body: { amount: "151.00", date: "2026-11-30", reason: WHY } });
    expect(excess.body.error).toBe("REFUND_EXCEEDS_SALE");
  });

  it("D9: juros e multa à parte; sem isso o excesso é bloqueado", async () => {
    const op = await ok(operationsRoute.POST, { operationType: "EXPENSE", operationDate: "2026-11-10", grossAmount: "100.00",
      description: "Boleto", installments: [{ dueDate: "2026-11-15" }] });
    const id = op.installmentIds[0];
    const tx = await bank("105.00", { direction: "DEBIT" });
    const pay = (extra: object) => call(reconcileRoute.POST, s.user,
      { body: { allocations: [alloc(tx, "OBLIGATION_INSTALLMENT", id, "105.00", extra)] } });
    expect((await pay({})).status).toBe(409);
    expect((await pay({ charge: { type: "INTEREST", amount: "9.00", justification: WHY } })).body.error).toBe("CHARGE_ONLY_FOR_EXCESS");
    const done = await pay({ charge: { type: "FINE", amount: "5.00", justification: WHY } });
    expect(done.status).toBe(201);
    expect(await parcel(id)).toMatchObject({ status: "SETTLED", settled_amount: "100.00" });
    await ok(reconcileReverse.POST, { reason: WHY }, { groupId: done.body.id });
    expect(await parcel(id)).toMatchObject({ status: "OPEN", settled_amount: "0.00" });
  });

  it("lançamento errado ainda não aprovado pode ser recusado e sai da previsão", async () => {
    const v = await sale("70.00", ["2026-12-25"]);
    expect((await call(rejectRoute.POST, s.user, { params: { operationId: v.id }, body: { reason: WHY } })).status).toBe(403);
    await ok(rejectRoute.POST, { reason: WHY }, { operationId: v.id }, s.reviewer);
    expect((await parcel(v.installmentIds[0])).status).toBe("CANCELLED");
  });

  it("Cenário 8: transferência interna com duas pernas não cria receita nem despesa", async () => {
    const before = (await row("SELECT count(*)::int AS n FROM economic_operations")).n;
    const out = await bank("2000.00", { direction: "DEBIT" });
    const into = await bank("2000.00", { financial_account_id: s.a.bankB });
    const t = await ok(transfersRoute.POST, { fromAccountId: s.a.bankA, toAccountId: s.a.bankB, date: "2026-11-28",
      amount: "2000.00", outflowBankTxId: out, inflowBankTxId: into });
    expect((await row("SELECT reconciliation_status AS v FROM internal_transfers WHERE id=$1", t.id)).v).toBe("RECONCILED");
    expect([await status(out), await status(into)]).toEqual(["RECONCILED", "RECONCILED"]);
    expect((await row("SELECT count(*)::int AS n FROM economic_operations")).n).toBe(before);
  });

  it("D7: com o mês da venda fechado, a taxa entra no mês do repasse e a liquidação não trava", async () => {
    const v = await sale("200.00", ["2027-01-10"], { operationDate: "2026-09-10" });
    await as(db, ctx(s.reviewer, s.a.id), (c) => insert(c, "period_closings",
      { tenant_id: s.a.id, competence_date: "2026-09-01", status: "CLOSED_PUBLISHED" }));
    const e = await ok(settlementsRoute.POST, { ...base(), settlementDate: "2026-11-28",
      items: [{ installmentId: v.installmentIds[0], grossAmount: "200.00", mdrFee: "4.00" }] });
    expect((await row("SELECT competence_date AS d FROM settlement_fee_items WHERE settlement_event_id=$1", e.id)).d).toBe("2026-11-28");
    await ok(settlementReverse.POST, { reason: WHY }, { settlementId: e.id }, s.reviewer);
    expect((await parcel(v.installmentIds[0])).status).toBe("OPEN");
  });

  it("relatório da adquirente vira venda, repasse e antecipação; aprovação é do revisor", async () => {
    const header = "external_nsu_tid;operation_date;installment_number;total_installments;gross_amount;mdr_fee_amount;anticipation_fee_amount;net_amount;expected_settlement_date;settlement_date;event_type";
    const csv = [header,
      "Z1;2026-11-05;1;2;100,00;2,00;0;98,00;2026-12-05;;SALE", "Z1;2026-11-05;2;2;100,00;2,00;0;98,00;2027-01-05;;SALE",
      "Z1;2026-11-05;1;2;100,00;2,00;0;98,00;;2026-12-05;SETTLEMENT",
      "Z1;2026-11-05;2;2;100,00;2,00;1,00;97,00;;2026-11-20;ANTICIPATION",
      "ZZ;2026-11-05;1;1;50,00;0;0;50,00;;2026-11-20;SETTLEMENT"].join("\n");
    const form = new FormData();
    form.set("file", new File([csv], "adq.csv"));
    form.set("data", JSON.stringify({ docCategory: "ACQUIRER_REPORT", acquirerId: s.a.acquirer }));
    const up = await call(documentsRoute.POST, s.user, { form });
    while (await processNext(db.app, storage));
    const result = await ok(applyRoute.POST, undefined, { batchId: up.body.batchId });
    expect(result).toMatchObject({ status: "IMPORTED_WITH_EXCEPTIONS", applied: 4, pending: 1 });
    expect((await row("SELECT item_note AS v FROM batch_items WHERE batch_id=$1 AND item_status='NEW_VALID'", up.body.batchId)).v).toBe("SALE_NOT_FOUND");
    const op = (await row("SELECT id FROM economic_operations WHERE external_nsu_tid='Z1'")).id;
    const detail = await ok(operationRoute.GET, undefined, { operationId: op });
    expect(detail.installments.map((i: { status: string }) => i.status)).toEqual(["SETTLED", "ANTICIPATED_SETTLED"]);
    expect((await call(approveRoute.POST, s.user, { body: { operationIds: [op] } })).status).toBe(403);
    await ok(approveRoute.POST, { operationIds: [op] }, {}, s.reviewer);
    expect((await call(operationRoute.GET, s.user, { params: { tenantId: s.b.id, operationId: op } })).status).toBe(403);
  });
});
