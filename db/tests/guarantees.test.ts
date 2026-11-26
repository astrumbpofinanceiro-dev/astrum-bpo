/** Etapa 6: varredura de isolamento e Modo Cego em todas as rotas, idempotência e regras de fechamento. */
import { readdirSync } from "node:fs";
import { join, sep } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as apply from "../../src/app/api/tenants/[tenantId]/batches/[batchId]/apply/route.ts";
import * as closing from "../../src/app/api/tenants/[tenantId]/closing/route.ts";
import * as validateBalance from "../../src/app/api/tenants/[tenantId]/balance-validations/[accountId]/route.ts";
import { MAX_ATTEMPTS, processNext } from "../../src/modules/import-processing/worker.ts";
import { getDeps } from "../../src/server/container.ts";
import { as, bankTx, ctx, insert, operation } from "./helpers.ts";
import { ofx, testApp, type App, type Handler } from "./app.ts";

const ROOT = "src/app/api/tenants/[tenantId]";
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
type Route = { path: string; method: (typeof METHODS)[number]; handler: Handler; params: string[] };

async function allRoutes(): Promise<Route[]> {
  const files = readdirSync(ROOT, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith("route.ts"));
  const routes: Route[] = [];
  for (const file of files) {
    const module = await import(/* @vite-ignore */ join(process.cwd(), ROOT, file));
    const path = file.split(sep).join("/").replace(/\/?route\.ts$/, "");
    for (const method of METHODS) {
      if (module[method]) routes.push({ path, method, handler: module[method], params: [...path.matchAll(/\[(\w+)\]/g)].map((m) => m[1]!) });
    }
  }
  return routes;
}

describe("isolamento e Modo Cego em todas as rotas", () => {
  let app: App;
  let routes: Route[];
  const foreign: Record<string, string> = {};

  beforeAll(async () => {
    app = await testApp();
    routes = await allRoutes();
    const { s } = app;
    const c = await app.db.admin.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.current_user_id',$1,true), set_config('app.actor_role','SYSTEM_WORKER',true)", [s.user]);
      foreign.operationId = foreign.entryId = await insert(c, "economic_operations", operation(s.b, s.user, "10.00"));
      foreign.accountId = s.b.bankA;
      foreign.issueId = await insert(c, "blocking_issues", { tenant_id: s.b.id, competence_date: "2026-11-01",
        target_entity_type: "OPERATION", target_entity_id: foreign.operationId, severity: "WARNING", status: "WAITING_CLIENT_RESPONSE",
        title: "de B", description: "de B", assigned_to_side: "CLIENT", opened_by_user_id: s.user });
      await c.query("COMMIT");
    } finally {
      c.release();
    }
  });
  afterAll(async () => { await app.close(); });

  const params = (route: Route) => Object.fromEntries(route.params.map((p) => [p, foreign[p] ?? crypto.randomUUID()]));
  const snapshot = async () => JSON.stringify(await app.rows(
    `SELECT (SELECT jsonb_agg(to_jsonb(o) ORDER BY id) FROM economic_operations o WHERE tenant_id = $1) AS operations,
            (SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM blocking_issues i WHERE tenant_id = $1) AS issues,
            (SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM financial_accounts a WHERE tenant_id = $1) AS accounts`, app.s.b.id));
  const people = () => [app.ids.analyst, app.ids.reviewer, app.ids.owner, app.ids.employee];

  it("encontra as rotas do cliente", () => {
    expect(routes.length).toBeGreaterThan(55);
  });

  it("usuário do Cliente A não lê nem altera o Cliente B em nenhuma rota", async () => {
    const before = await snapshot();
    for (const user of people()) {
      for (const route of routes) {
        const r = await app.call(route.handler, user, { method: route.method, tenant: app.s.b.id, params: params(route),
          query: "?month=2026-11", body: route.method === "GET" || route.method === "DELETE" ? undefined : {} });
        const label = `${route.method} ${route.path} → ${r.status}`;
        // leitura: sempre negada; escrita: negada na autorização ou antes dela, na validação
        expect(route.method === "GET" ? [403] : [400, 403], label).toContain(r.status);
      }
    }
    expect(await snapshot()).toBe(before);
  });

  it("IDs do Cliente B usados no caminho do Cliente A não funcionam", async () => {
    const before = await snapshot();
    for (const route of routes.filter((r) => r.params.some((p) => foreign[p]))) {
      for (const user of people()) {
        const r = await app.call(route.handler, user, { method: route.method, params: params(route),
          body: route.method === "GET" || route.method === "DELETE" ? undefined
            : { reason: "tentativa entre empresas", text: "tentativa", decision: "ACCEPT", amount: "1.00", date: "2026-11-30" } });
        expect(r.status, `${route.method} ${route.path}`).toBeGreaterThanOrEqual(400);
        expect(r.status, `${route.method} ${route.path}`).toBeLessThan(500);
      }
    }
    expect(await snapshot()).toBe(before);
  });

  it("funcionário em Modo Cego só alcança as listas permitidas", async () => {
    const open: string[] = [];
    for (const route of routes.filter((r) => r.method === "GET")) {
      const r = await app.call(route.handler, app.ids.employee, { params: params(route), query: "?month=2026-11" });
      if (r.status === 200) open.push(route.path);
    }
    // nada de relatórios, saldos, fechamento, operações, conciliação, auditoria ou equipe
    expect(open.sort()).toEqual(["", "accounts", "business-units", "documents", "entries", "issues", "routine-items"]);
    const accounts = await app.call(routes.find((r) => r.path === "accounts" && r.method === "GET")!.handler, app.ids.employee);
    expect(JSON.stringify(accounts.body)).not.toMatch(/balance/);
  });
});

describe("idempotência da importação", () => {
  let app: App;
  beforeAll(async () => { app = await testApp(); });
  afterAll(async () => { await app.close(); });
  const count = async (table: string) => (await app.rows(`SELECT count(*)::int AS n FROM ${table}`))[0].n;

  it("o mesmo arquivo enviado duas vezes, com dois workers ao mesmo tempo, grava uma vez", async () => {
    const file = ofx("2026-11-01", "2026-11-10", [["2026-11-01", "10.00", "I1"], ["2026-11-10", "-4.00", "I2"]]);
    const data = { docCategory: "BANK_STATEMENT", financialAccountId: app.s.a.bankA };
    await app.upload(app.s.user, "a.ofx", file, data);
    await app.upload(app.s.user, "b.ofx", file, data);
    const { pool, storage } = await getDeps();
    await Promise.all([processNext(pool, storage), processNext(pool, storage)]);
    await app.work();
    expect(await count("bank_transactions")).toBe(2);
  });

  it("aplicar o relatório da adquirente duas vezes não duplica vendas nem repasses", async () => {
    const csv = ["external_nsu_tid;operation_date;installment_number;total_installments;gross_amount;mdr_fee_amount;anticipation_fee_amount;net_amount;expected_settlement_date;settlement_date;event_type",
      "I9;2026-11-25;1;1;100,00;0;0;100,00;2026-12-25;;SALE", "I9;2026-11-25;1;1;100,00;0;0;100,00;;2026-11-28;SETTLEMENT"].join("\n");
    const data = { docCategory: "ACQUIRER_REPORT", acquirerId: app.s.a.acquirer };
    const first = await app.upload(app.s.user, "1.csv", csv, data);
    await app.work();
    const run = (batchId: string) => app.call(apply.POST, app.s.user, { method: "POST", params: { batchId } });
    expect((await run(first.batchId!)).body).toMatchObject({ applied: 2 });
    expect((await run(first.batchId!)).status).toBe(409);
    const again = await app.upload(app.s.user, "2.csv", csv, data);
    await app.work();
    expect((await run(again.batchId!)).status).toBe(409);
    expect(await count("economic_operations")).toBe(1);
    expect(await count("settlement_events")).toBe(1);
  });
});

describe("regras de fechamento", () => {
  let app: App;
  beforeAll(async () => { app = await testApp(); });
  afterAll(async () => { await app.close(); });

  const failing = async () => (await app.ok(closing.GET, app.s.reviewer, { query: "?month=2026-11" }))
    .checklist.items.filter((i: { ok: boolean }) => !i.ok).map((i: { code: string }) => i.code);
  const publish = (caveats?: object) => app.call(closing.POST, app.s.reviewer, { body: { month: "2026-11", ...(caveats && { caveats }) } });
  const sql = (table: string, row: Record<string, unknown>) =>
    as(app.db, ctx(app.s.user, app.s.a.id), (c) => insert(c, table, row));

  it("cada item do checklist impede a publicação completa", async () => {
    const { s } = app;
    expect(await failing()).toEqual(["INITIAL_BALANCES"]);
    for (const accountId of [s.a.bankA, s.a.bankB]) await app.ok(validateBalance.POST, s.reviewer, { method: "POST", params: { accountId } });
    expect(await failing()).toEqual([]);

    // falha repetida do armazenamento esgota as tentativas e deixa o lote em FAILED_IMPORT
    await app.upload(s.user, "falha.ofx", ofx("2026-11-01", "2026-11-02", [["2026-11-01", "1.00", "F1"]]),
      { docCategory: "BANK_STATEMENT", financialAccountId: s.a.bankA, competenceDate: "2026-11-01" });
    const { pool, storage } = await getDeps();
    const broken = { ...storage, async get(): Promise<Buffer> { throw new Error("indisponível"); } };
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      await app.db.admin.query("UPDATE app.processing_queue SET next_attempt_at = now()");
      await processNext(pool, broken);
    }
    expect(await failing()).toEqual(["NO_STUCK_BATCHES"]);
    await sql("cash_transactions", { tenant_id: s.a.id, financial_account_id: s.a.bankA, transaction_date: "2026-11-05",
      amount: "1.00", direction: "OUTFLOW", origin_type: "BPO_ENTRY", created_by_user_id: s.user, review_status: "SUBMITTED_PENDING_BPO",
      business_unit_id: s.a.unit });
    await sql("bank_transactions", bankTx(s.a, "5.00"));
    expect(await failing()).toEqual(expect.arrayContaining(["NO_STUCK_BATCHES", "ENTRIES_REVIEWED", "RECONCILED"]));
    expect((await publish()).status).toBe(409);
  });

  it("pendência CRITICAL não é ressalvada; ressalva exige justificativa e todas as pendências", async () => {
    const issue = (severity: string) => sql("blocking_issues", { tenant_id: app.s.a.id, competence_date: "2026-11-01",
      target_entity_type: "PERIOD_CLOSING", target_entity_id: crypto.randomUUID(), severity, status: "WAITING_BPO_ACTION",
      title: severity, description: severity, assigned_to_side: "BPO", opened_by_user_id: app.s.user });
    const blocking = [await issue("BLOCKING_OPERATIONAL"), await issue("BLOCKING_OPERATIONAL")];
    const critical = await issue("CRITICAL");
    const caveats = { justification: "justificativa com mais de vinte caracteres", reviewDeadline: "2026-12-15",
      responsibleUserId: app.s.reviewer, issueIds: blocking };

    expect((await publish(caveats)).body.error).toBe("CHECKLIST_NO_CRITICAL");
    await app.db.admin.query("SELECT set_config('app.current_user_id',$1,false), set_config('app.actor_role','SYSTEM_WORKER',false)", [app.s.user]);
    await app.db.admin.query("UPDATE blocking_issues SET status = 'RESOLVED', resolved_by_user_id = $2, resolved_at = now() WHERE id = $1",
      [critical, app.s.reviewer]);
    expect((await publish({ ...caveats, justification: "curta" })).status).toBe(400);
    expect((await publish({ ...caveats, issueIds: [blocking[0]] })).body.error).toBe("CAVEAT_ISSUES_MISMATCH");
    expect((await publish(caveats)).body).toMatchObject({ version: 1, closingType: "PUBLISHED_WITH_CAVEATS" });
    expect((await publish(caveats)).body.error).toBe("ALREADY_CLOSED");
    // versão publicada não muda nem por SQL
    await expect(app.db.admin.query("UPDATE closing_versions SET snapshot_summary = '{}'")).rejects.toThrow();
  });
});

describe("rota agendada de processamento", () => {
  it("recusa sem o segredo correto", async () => {
    const { GET } = await import("../../src/app/api/internal/process/route.ts");
    const call = async (authorization?: string) =>
      (await GET(new Request("http://app.test/api/internal/process", { headers: authorization ? { authorization } : {} }))).status;
    expect(await call()).toBe(401);
    process.env.CRON_SECRET = "segredo-de-teste-com-32-caracteres";
    expect(await call("Bearer errado")).toBe(401);
    delete process.env.CRON_SECRET;
  });
});
