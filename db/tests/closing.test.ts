/** Etapa 5: fechamento, relatórios, rotina. Totais dos cenários 3, 4, 8 e fluxo dos cenários 9 e 10. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setDeps } from "../../src/server/container.ts";
import * as operationsRoute from "../../src/app/api/tenants/[tenantId]/operations/route.ts";
import * as approveRoute from "../../src/app/api/tenants/[tenantId]/operations/approve/route.ts";
import * as refundRoute from "../../src/app/api/tenants/[tenantId]/operations/[operationId]/refunds/route.ts";
import * as anticipationsRoute from "../../src/app/api/tenants/[tenantId]/anticipations/route.ts";
import * as reconcileRoute from "../../src/app/api/tenants/[tenantId]/reconciliations/route.ts";
import * as reportsRoute from "../../src/app/api/tenants/[tenantId]/reports/route.ts";
import * as closingRoute from "../../src/app/api/tenants/[tenantId]/closing/route.ts";
import * as reopenRoute from "../../src/app/api/tenants/[tenantId]/closing/reopen/route.ts";
import * as versionsRoute from "../../src/app/api/tenants/[tenantId]/closing-versions/route.ts";
import * as versionRoute from "../../src/app/api/tenants/[tenantId]/closing-versions/[versionId]/route.ts";
import * as approvalsRoute from "../../src/app/api/tenants/[tenantId]/approvals/[approvalId]/route.ts";
import * as balanceRoute from "../../src/app/api/tenants/[tenantId]/balance-validations/[accountId]/route.ts";
import * as issuesRoute from "../../src/app/api/tenants/[tenantId]/issues/route.ts";
import * as issueReopen from "../../src/app/api/tenants/[tenantId]/issues/[issueId]/reopen/route.ts";
import * as validateRoute from "../../src/app/api/tenants/[tenantId]/issues/[issueId]/validate/route.ts";
import * as routinesRoute from "../../src/app/api/tenants/[tenantId]/routines/route.ts";
import * as itemsRoute from "../../src/app/api/tenants/[tenantId]/routine-items/route.ts";
import { as, bankTx, createTestDb, ctx, insert, seed, type Seed, type TestDb } from "./helpers.ts";

type Handler = (r: Request, s?: { params: Promise<Record<string, string>> }) => Promise<Response>;
const WHY = "justificativa detalhada para o teste";

describe("fechamento e relatórios", () => {
  let db: TestDb;
  let s: Seed;
  let owner = "", reviewer2 = "";

  async function call(handler: Handler, user: string, o: { method?: string; params?: Record<string, string>; body?: unknown; query?: string } = {}) {
    const response = await handler(
      new Request(`http://app.test/api${o.query ?? ""}`, {
        method: o.method ?? (o.body === undefined ? "GET" : "POST"),
        headers: { origin: "http://app.test", "x-user": user },
        body: o.body === undefined ? undefined : JSON.stringify(o.body),
      }), { params: Promise.resolve({ tenantId: s.a.id, ...o.params }) });
    return { status: response.status, body: await response.json() };
  }
  const ok = async (handler: Handler, user: string, o: Parameters<typeof call>[2] = {}) => {
    const r = await call(handler, user, o);
    expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
    return r.body;
  };
  const bank = (amount: string, extra: Record<string, unknown> = {}) =>
    as(db, ctx(s.user, s.a.id), (c) => insert(c, "bank_transactions", bankTx(s.a, amount, extra)));
  const report = (m: string) => ok(reportsRoute.GET, s.user, { query: `?month=${m}` });
  const setting = (key: string, value: unknown) => as(db, ctx(s.master, s.a.id, { actorRole: "BPO_MASTER", impersonationReason: "teste" }),
    (c) => c.query(`INSERT INTO client_settings (tenant_id, setting_key, setting_value, effective_from, version, updated_by_user_id)
      VALUES ($1,$2,$3,'2026-01-01',1,$4)`, [s.a.id, key, JSON.stringify(value), s.master]));

  beforeAll(async () => {
    db = await createTestDb();
    s = await seed(db);
    setDeps({
      pool: db.app, appUrl: "http://app.test",
      storage: { bucket: "t", async put() {}, async get() { return Buffer.alloc(0); }, async signedUrl() { return ""; }, async remove() {} },
      verifySession: async (r) => ({ userId: r.headers.get("x-user")!, aal: "aal2", hasVerifiedFactor: false }),
      identity: { async invite() { throw new Error("n/a"); }, async remove() {} },
    });
    const c = await db.admin.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.current_user_id',$1,true), set_config('app.actor_role','SYSTEM_WORKER',true)", [s.user]);
      reviewer2 = await insert(c, "users", { email: "rev2@teste.local", full_name: "Revisor 2" });
      owner = await insert(c, "users", { email: "dono@a.local", full_name: "Dono" });
      for (const [user_id, bpo_role] of [[s.user, "BPO_ANALYST"], [s.reviewer, "BPO_REVIEWER"], [reviewer2, "BPO_REVIEWER"]]) {
        await insert(c, "bpo_staff_assignments", { user_id, tenant_id: s.a.id, bpo_role });
      }
      await insert(c, "tenant_memberships", { tenant_id: s.a.id, user_id: owner, client_role: "CLIENT_MASTER", is_blind_mode: false });
      await c.query("COMMIT");
    } finally {
      c.release();
    }
  });
  afterAll(async () => { setDeps(undefined); await db.close(); });

  let sale = "";
  it("Cenários 3, 4 e 8: totais de competência, caixa e previsão", async () => {
    const purchase = await ok(operationsRoute.POST, s.user, { body: { operationType: "PURCHASE", operationDate: "2026-11-28",
      grossAmount: "1200.00", description: "Nota de compra", installments: [{ dueDate: "2026-12-05" }] } });
    const v = await ok(operationsRoute.POST, s.user, { body: { operationType: "SALE", operationDate: "2026-11-25", grossAmount: "5000.00",
      description: "Venda cartão", acquirerId: s.a.acquirer, expectedFeeAmount: "100.00", installments: [{ dueDate: "2026-12-25" }] } });
    sale = v.id;
    await ok(approveRoute.POST, s.reviewer, { body: { operationIds: [purchase.id, v.id] } });
    const a = await ok(anticipationsRoute.POST, s.user, { body: { financialAccountId: s.a.bankA, acquirerId: s.a.acquirer,
      requestedAt: "2026-11-27", effectiveDate: "2026-11-27",
      items: [{ installmentId: v.installmentIds[0], grossAmount: "5000.00", mdrFee: "100.00", anticipationFee: "50.00" }] } });
    const credit = await bank("4850.00");
    await ok(reconcileRoute.POST, s.user, { body: { allocations: [{ movementType: "BANK_TRANSACTION", movementId: credit,
      targetType: "SETTLEMENT_EVENT", targetId: a.settlementId, amount: "4850.00" }] } });

    let nov = await report("2026-11");
    expect(nov.competence).toMatchObject({ grossRevenue: "5000.00", costsAndExpenses: "1200.00", financialFees: "150.00", operatingResult: "3650.00" });
    expect(nov.cash).toMatchObject({ inflows: "4850.00", outflows: "0.00" });
    expect(nov.forecast).toMatchObject({ receivables: "0.00", payables: "1200.00" });

    const debit = await bank("1200.00", { direction: "DEBIT", bank_posting_date: "2026-12-05" });
    await ok(reconcileRoute.POST, s.user, { body: { allocations: [{ movementType: "BANK_TRANSACTION", movementId: debit,
      targetType: "OBLIGATION_INSTALLMENT", targetId: purchase.installmentIds[0], amount: "1200.00" }] } });
    expect((await report("2026-12")).cash).toMatchObject({ outflows: "1200.00", netCashFlow: "-1200.00" });
    nov = await report("2026-11");
    expect(nov.cash.outflows).toBe("0.00");
    expect(nov.indicators.find((i: { code: string }) => i.code === "IND_CASH_FLOW_BALANCE")).toMatchObject({ quality: "UNAVAILABLE", value: null });
    expect((await call(reportsRoute.GET, owner, { query: "?month=2026-11" })).status).toBe(403); // cliente só vê publicado
  });

  it("Cenários 9 e 10: checklist, ressalva com 2ª aprovação, reabertura e nova versão", async () => {
    await setting("DUAL_APPROVAL_ENABLED", true);
    await setting("DUAL_APPROVAL_THRESHOLD", "1000.00");
    const publish = (user: string, extra: object = {}) => call(closingRoute.POST, user, { body: { month: "2026-11", ...extra } });
    expect((await publish(s.reviewer)).body.error).toBe("CHECKLIST_INITIAL_BALANCES");
    for (const account of [s.a.bankA, s.a.bankB]) {
      expect((await call(balanceRoute.POST, s.user, { method: "POST", params: { accountId: account } })).status).toBe(403);
      await ok(balanceRoute.POST, s.reviewer, { method: "POST", params: { accountId: account } });
    }
    const issue = (await ok(issuesRoute.POST, s.user, { body: { competenceDate: "2026-11-10", targetType: "OPERATION", targetId: sale,
      severity: "BLOCKING_OPERATIONAL", title: "Falta nota", description: "Enviar nota", assignedToSide: "BPO" } })).id;
    expect((await publish(s.reviewer)).body.error).toBe("CHECKLIST_NO_BLOCKING");
    expect((await publish(s.user)).status).toBe(403);

    const caveats = { justification: WHY, reviewDeadline: "2026-12-15", responsibleUserId: s.reviewer, issueIds: [issue] };
    const pending = (await publish(s.reviewer, { caveats })).body;
    expect(pending.pendingApprovalId).toBeTruthy();
    const decide = (user: string) => call(approvalsRoute.POST, user, { params: { approvalId: pending.pendingApprovalId }, body: { decision: "APPROVE" } });
    expect((await decide(s.reviewer)).body.error).toBe("SECOND_PERSON_REQUIRED");
    expect((await decide(reviewer2)).body).toMatchObject({ status: "APPROVED", result: { version: 1 } });

    // imutável enquanto fechado
    const late = await call(operationsRoute.POST, s.user, { body: { operationType: "EXPENSE", operationDate: "2026-11-02",
      grossAmount: "1.00", description: "tardia", installments: [{ dueDate: "2026-11-02" }] } });
    expect(late.body.error).toBe("PERIOD_CLOSED");

    const v1 = (await ok(versionsRoute.GET, owner))[0];
    const before = (await ok(versionRoute.GET, owner, { params: { versionId: v1.id } })).snapshot;
    expect(before.competence.operatingResult).toBe("3650.00");

    // reabertura sempre pede 2ª pessoa; estorno só a partir do limite
    const reopen = await ok(reopenRoute.POST, s.reviewer, { body: { month: "2026-11", reason: WHY } });
    expect(reopen.pendingApprovalId).toBeTruthy();
    await ok(approvalsRoute.POST, reviewer2, { params: { approvalId: reopen.pendingApprovalId }, body: { decision: "APPROVE" } });
    const refund = await ok(refundRoute.POST, s.reviewer, { params: { operationId: sale }, body: { amount: "100.00", date: "2026-11-29", reason: WHY } });
    expect(refund.chargebackInstallmentId).toBeTruthy();
    expect((await ok(refundRoute.POST, s.reviewer, { params: { operationId: sale }, body: { amount: "1000.00", date: "2026-11-29", reason: WHY } })).pendingApprovalId).toBeTruthy();

    await ok(issueReopen.POST, s.reviewer, { params: { issueId: issue }, body: { reason: WHY } });
    expect((await publish(s.reviewer)).body.error).toBe("CHECKLIST_NO_BLOCKING");
    await ok(validateRoute.POST, s.reviewer, { params: { issueId: issue }, body: { decision: "ACCEPT", reason: "nota recebida" } });
    expect((await publish(s.reviewer)).body.version).toBe(2);

    const { rows } = await db.admin.query("SELECT version_number AS n, status, snapshot_summary->'competence'->>'operatingResult' AS r FROM closing_versions ORDER BY 1");
    expect(rows).toEqual([{ n: 1, status: "SUPERSEDED", r: "3650.00" }, { n: 2, status: "ACTIVE", r: "3550.00" }]);
    expect((await call(versionRoute.GET, owner, { params: { versionId: v1.id } })).status).toBe(403);
    const audit = await db.admin.query("SELECT count(*)::int AS n FROM audit_logs WHERE entity_type='period_closings'");
    expect(audit.rows[0].n).toBeGreaterThan(2);
  });

  it("rotina gera itens uma única vez", async () => {
    await ok(supportStart, s.master);
    await ok(routinesRoute.POST, s.master, { body: { title: "Extrato mensal", frequency: "MONTHLY", expectedSourceType: "BANK_STATEMENT", dueDayOffset: 5 } });
    const generate = () => ok(routinesRoute.PUT, s.user, { method: "PUT", query: "?month=2026-12" });
    expect((await generate()).created).toBe(1);
    expect((await generate()).created).toBe(0);
    expect((await ok(itemsRoute.GET, owner, { query: "?month=2026-12" }))[0]).toMatchObject({ due_date: "2027-01-05", status: "PENDING" });
  });
  it("funcionário em Modo Cego: só o checklist; nada de relatórios ou previsões", async () => {
    const employee = (await db.admin.query("SELECT gen_random_uuid() AS id")).rows[0].id as string;
    const c = await db.admin.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.current_user_id',$1,true), set_config('app.actor_role','SYSTEM_WORKER',true)", [s.user]);
      await insert(c, "users", { id: employee, email: "func@a.local", full_name: "Funcionária" });
      const membership = await insert(c, "tenant_memberships", { tenant_id: s.a.id, user_id: employee, client_role: "CLIENT_EMPLOYEE", is_blind_mode: true });
      await insert(c, "user_scopes", { tenant_id: s.a.id, membership_id: membership, business_unit_id: s.a.unit });
      await c.query("COMMIT");
    } finally {
      c.release();
    }
    expect((await call(itemsRoute.GET, employee, { query: "?month=2026-12" })).status).toBe(200);
    expect((await call(versionsRoute.GET, employee)).status).toBe(403);
    expect((await call(reportsRoute.GET, employee, { query: "?month=2026-11" })).status).toBe(403);
    expect((await call(closingRoute.GET, employee, { query: "?month=2026-11" })).status).toBe(403);
  });
  let supportStart: Handler;
  beforeAll(async () => {
    const route = await import("../../src/app/api/support-sessions/route.ts");
    supportStart = (r) => route.POST(new Request(r.url, { method: "POST", headers: r.headers,
      body: JSON.stringify({ tenantId: s.a.id, reason: "configurar rotina do cliente" }) }));
  });
});
