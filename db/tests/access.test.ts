/** Etapa 2: as rotas reais, com banco real; apenas o provedor de identidade é falso. */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setDeps } from "../../src/server/container.ts";
import { AppError } from "../../src/shared/errors.ts";
import * as meRoute from "../../src/app/api/me/route.ts";
import * as tenantsRoute from "../../src/app/api/tenants/route.ts";
import * as tenantRoute from "../../src/app/api/tenants/[tenantId]/route.ts";
import * as supportRoute from "../../src/app/api/support-sessions/route.ts";
import * as staffUsersRoute from "../../src/app/api/staff-users/route.ts";
import * as staffUserRoute from "../../src/app/api/staff-users/[userId]/route.ts";
import * as staffRoute from "../../src/app/api/tenants/[tenantId]/staff/route.ts";
import * as usersRoute from "../../src/app/api/tenants/[tenantId]/users/route.ts";
import * as memberRoute from "../../src/app/api/tenants/[tenantId]/users/[membershipId]/route.ts";
import * as scopesRoute from "../../src/app/api/tenants/[tenantId]/users/[membershipId]/scopes/route.ts";
import * as settingsRoute from "../../src/app/api/tenants/[tenantId]/settings/route.ts";
import * as unitsRoute from "../../src/app/api/tenants/[tenantId]/business-units/route.ts";
import * as accountsRoute from "../../src/app/api/tenants/[tenantId]/accounts/route.ts";
import * as balancesRoute from "../../src/app/api/tenants/[tenantId]/balances/route.ts";
import * as entriesRoute from "../../src/app/api/tenants/[tenantId]/entries/route.ts";
import * as entryRoute from "../../src/app/api/tenants/[tenantId]/entries/[entryId]/route.ts";
import * as auditRoute from "../../src/app/api/tenants/[tenantId]/audit-logs/route.ts";
import { createTestDb, insert, operation, seed, type Seed, type TestDb } from "./helpers.ts";

const ORIGIN = "http://app.test";
type Handler = (r: Request, s?: { params: Promise<Record<string, string>> }) => Promise<Response>;

describe("identidade, permissões e Modo Cego (rotas)", () => {
  let db: TestDb;
  let s: Seed;
  const ids = { analyst: "", reviewer: "", auditor: "", master: "", clientMaster: "", employee: "" };
  let employeeMembership = "";
  let unit2 = "";
  const entry = { ownUnit1: "", otherUserUnit1: "", ownUnit2: "", ownApproved: "" };
  const removed: string[] = [];
  const invited = new Map<string, string>();

  async function call(handler: Handler, user: string | null, options: {
    method?: string; params?: Record<string, string>; body?: unknown; aal?: string; query?: string; origin?: string;
  } = {}) {
    const headers: Record<string, string> = { origin: options.origin ?? ORIGIN };
    if (user) Object.assign(headers, { "x-user": user, "x-aal": options.aal ?? "aal2" });
    const response = await handler(
      new Request(`${ORIGIN}/api${options.query ?? ""}`, {
        method: options.method ?? "GET", headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      }),
      { params: Promise.resolve(options.params ?? {}) });
    return { status: response.status, body: await response.json() };
  }

  beforeAll(async () => {
    db = await createTestDb();
    s = await seed(db);
    setDeps({
      pool: db.app,
      appUrl: ORIGIN,
      verifySession: async (r) => {
        const userId = r.headers.get("x-user");
        return userId ? { userId, aal: r.headers.get("x-aal") as "aal1" | "aal2", hasVerifiedFactor: false } : null;
      },
      storage: { bucket: "t", async put() {}, async get() { return Buffer.alloc(0); }, async signedUrl() { return ""; }, async remove() {} },
      identity: {
        async invite(email) {
          if (invited.has(email)) throw new AppError(409, "USER_CANNOT_BE_INVITED");
          const id = randomUUID();
          invited.set(email, id);
          return id;
        },
        async remove(id) { removed.push(id); },
      },
    });

    const c = await db.admin.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.current_user_id',$1,true), set_config('app.actor_role','SYSTEM_WORKER',true)", [s.user]);
      Object.assign(ids, { analyst: s.user, reviewer: s.reviewer, master: s.master });
      ids.auditor = await insert(c, "users", { email: "auditor@teste.local", full_name: "Auditor" });
      ids.clientMaster = await insert(c, "users", { email: "dono@a.local", full_name: "Dono A" });
      ids.employee = await insert(c, "users", { email: "func@a.local", full_name: "Funcionario X" });
      for (const [user_id, bpo_role] of [[ids.analyst, "BPO_ANALYST"], [ids.reviewer, "BPO_REVIEWER"], [ids.auditor, "BPO_AUDITOR"]]) {
        await insert(c, "bpo_staff_assignments", { user_id, tenant_id: s.a.id, bpo_role });
      }
      await insert(c, "tenant_memberships",
        { tenant_id: s.a.id, user_id: ids.clientMaster, client_role: "CLIENT_MASTER", is_blind_mode: false });
      employeeMembership = await insert(c, "tenant_memberships",
        { tenant_id: s.a.id, user_id: ids.employee, client_role: "CLIENT_EMPLOYEE" });
      await insert(c, "user_scopes", { tenant_id: s.a.id, membership_id: employeeMembership, business_unit_id: s.a.unit });
      unit2 = await insert(c, "business_units", { tenant_id: s.a.id, name: "Unidade 2" });
      const op = (user: string, unit: string, extra = {}) =>
        insert(c, "economic_operations", operation(s.a, user, "10.00", { business_unit_id: unit, ...extra }));
      entry.ownUnit1 = await op(ids.employee, s.a.unit);
      entry.otherUserUnit1 = await op(ids.clientMaster, s.a.unit);
      entry.ownUnit2 = await op(ids.employee, unit2);
      entry.ownApproved = await op(ids.employee, s.a.unit, { review_status: "APPROVED_FOR_LEDGER" });
      await c.query("COMMIT");
    } finally {
      c.release();
    }
  });
  afterAll(async () => { setDeps(undefined); await db.close(); });

  const A = () => ({ tenantId: s.a.id });

  it("exige sessão, e MFA para equipe BPO e Master Cliente", async () => {
    expect((await call(meRoute.GET, null)).status).toBe(401);
    for (const user of [ids.analyst, ids.clientMaster, ids.master]) {
      expect((await call(meRoute.GET, user, { aal: "aal1" })).body).toEqual({ error: "MFA_REQUIRED" });
    }
    expect((await call(meRoute.GET, ids.employee, { aal: "aal1" })).status).toBe(200);
  });

  it("Cenário 1: funcionário em Modo Cego recebe 403 fora do escopo e vê só o que é seu", async () => {
    const x = ids.employee;
    expect((await call(entriesRoute.GET, x, { params: { tenantId: s.b.id } })).status).toBe(403);
    expect((await call(tenantRoute.GET, x, { params: { tenantId: s.b.id } })).status).toBe(403);
    expect((await call(balancesRoute.GET, x, { params: A() })).status).toBe(403);
    expect((await call(entriesRoute.GET, x, { params: A(), query: `?businessUnitId=${unit2}` })).status).toBe(403);
    for (const id of [entry.otherUserUnit1, entry.ownUnit2, entry.ownApproved]) {
      expect((await call(entryRoute.GET, x, { params: { ...A(), entryId: id } })).status).toBe(403);
    }
    const list = await call(entriesRoute.GET, x, { params: A() });
    expect(list.body.map((e: { id: string }) => e.id)).toEqual([entry.ownUnit1]);
    const accounts = await call(accountsRoute.GET, x, { params: A() });
    expect(JSON.stringify(accounts.body)).not.toContain("initial_balance");
    const { rows } = await db.admin.query(
      "SELECT count(*)::int AS n FROM audit_logs WHERE action='ACCESS_DENIED' AND actor_user_id=$1 AND tenant_id IS NULL", [x]);
    expect(rows[0].n).toBe(7);
  });

  it("analista fora da carteira e auditor tentando escrever são negados", async () => {
    expect((await call(entriesRoute.GET, ids.analyst, { params: { tenantId: s.b.id } })).status).toBe(403);
    expect((await call(entriesRoute.GET, ids.analyst, { params: A() })).body).toHaveLength(4);
    expect((await call(unitsRoute.POST, ids.auditor, { method: "POST", params: A(), body: { name: "x" } })).status).toBe(403);
    expect((await call(auditRoute.GET, ids.auditor, { params: A() })).status).toBe(200);
    expect((await call(auditRoute.GET, ids.analyst, { params: A() })).status).toBe(403);
    const visible = await call(tenantsRoute.GET, ids.analyst);
    expect(visible.body.map((t: { id: string }) => t.id)).toEqual([s.a.id]);
  });

  it("escrita de outra origem é recusada (CSRF)", async () => {
    const r = await call(tenantsRoute.POST, ids.master, { method: "POST", origin: "http://mal.test", body: {} });
    expect(r.status).toBe(403);
  });

  it("Master precisa de sessão de suporte; ações ficam marcadas e o fim revoga o acesso", async () => {
    const m = ids.master;
    expect((await call(tenantRoute.GET, m, { params: A() })).body).toEqual({ error: "SUPPORT_SESSION_REQUIRED" });
    const short = await call(supportRoute.POST, m, { method: "POST", body: { tenantId: s.a.id, reason: "oi" } });
    expect(short.status).toBe(400);
    expect((await call(supportRoute.POST, m, { method: "POST", body: { tenantId: s.a.id, reason: "Chamado 42 do cliente" } })).status).toBe(201);
    const unit = await call(unitsRoute.POST, m, { method: "POST", params: A(), body: { name: "Filial" } });
    expect(unit.status).toBe(201);
    const { rows } = await db.admin.query(
      "SELECT is_bpo_master_impersonation AS imp, impersonation_reason AS why FROM audit_logs WHERE entity_id=$1", [unit.body.id]);
    expect(rows).toEqual([{ imp: true, why: "Chamado 42 do cliente" }]);
    // a sessão vale só para o cliente escolhido
    expect((await call(tenantRoute.GET, m, { params: { tenantId: s.b.id } })).status).toBe(403);
    await call(supportRoute.DELETE, m, { method: "DELETE", body: { tenantId: s.a.id } });
    expect((await call(tenantRoute.GET, m, { params: A() })).status).toBe(403);
    const events = await db.admin.query(
      "SELECT action FROM audit_logs WHERE entity_type='support_session' AND tenant_id=$1 ORDER BY created_at", [s.a.id]);
    expect(events.rows.map((r) => r.action)).toEqual(["SUPPORT_ACCESS_START", "SUPPORT_ACCESS_END"]);
  });

  it("somente o Master abre sessão de suporte", async () => {
    const r = await call(supportRoute.POST, ids.reviewer, { method: "POST", body: { tenantId: s.a.id, reason: "tentativa indevida" } });
    expect(r.status).toBe(403);
  });

  it("Master Cliente cria só funcionário, dentro dos limites do BPO", async () => {
    const create = (body: object, tenantId = s.a.id) =>
      call(usersRoute.POST, ids.clientMaster, { method: "POST", params: { tenantId }, body });
    const base = { email: "novo@a.local", fullName: "Novo", clientRole: "CLIENT_EMPLOYEE" };
    expect((await create({ ...base, clientRole: "CLIENT_MASTER" })).status).toBe(403);
    expect((await create({ ...base, isBlindMode: false })).status).toBe(403);
    expect((await create({ ...base, scopes: [{ canViewBankBalances: true }] })).status).toBe(403);
    expect((await create(base, s.b.id)).status).toBe(403);
    expect(invited.has("novo@a.local")).toBe(false); // nada é enviado antes de autorizar

    const ok = await create({ ...base, scopes: [{ businessUnitId: s.a.unit }] });
    expect(ok.status).toBe(201);
    const { rows } = await db.admin.query("SELECT is_blind_mode FROM tenant_memberships WHERE id=$1", [ok.body.membershipId]);
    expect(rows).toEqual([{ is_blind_mode: true }]);
    // e-mail já usado (inclusive em outro cliente) não é reconvidado nem apagado
    expect((await create({ ...base, email: "analista@teste.local" })).status).toBe(409);
    expect(removed).toEqual([]);
    // não altera o próprio vínculo
    const self = await db.admin.query("SELECT id FROM tenant_memberships WHERE user_id=$1", [ids.clientMaster]);
    expect((await call(memberRoute.PATCH, ids.clientMaster,
      { method: "PATCH", params: { ...A(), membershipId: self.rows[0].id }, body: { isActive: false } })).status).toBe(403);
  });

  it("escopo de outra empresa é rejeitado e a conta convidada é desfeita", async () => {
    const r = await call(usersRoute.POST, ids.clientMaster, { method: "POST", params: A(),
      body: { email: "x@a.local", fullName: "X", clientRole: "CLIENT_EMPLOYEE", scopes: [{ businessUnitId: s.b.unit }] } });
    expect(r.status).toBe(400);
    expect(removed).toEqual([invited.get("x@a.local")]);
  });

  it("troca de escopos vale na requisição seguinte e deixa trilha", async () => {
    const put = await call(scopesRoute.PUT, ids.clientMaster, { method: "PUT",
      params: { ...A(), membershipId: employeeMembership }, body: [{ businessUnitId: unit2 }] });
    expect(put.status).toBe(200);
    const list = await call(entriesRoute.GET, ids.employee, { params: A() });
    expect(list.body.map((e: { id: string }) => e.id)).toEqual([entry.ownUnit2]);
    const { rows } = await db.admin.query("SELECT 1 FROM audit_logs WHERE entity_type='user_scopes' AND action='DELETE'");
    expect(rows).toHaveLength(1);
  });

  it("configurações têm vigência, versão e não são retroativas", async () => {
    await call(supportRoute.POST, ids.master, { method: "POST", body: { tenantId: s.a.id, reason: "Ajuste de configuração" } });
    const post = (value: unknown, effectiveFrom: string) => call(settingsRoute.POST, ids.master,
      { method: "POST", params: A(), body: { key: "MANUAL_RECEIPT_THRESHOLD", value, effectiveFrom } });
    expect((await post("100.00", "2026-11-01")).status).toBe(201);
    expect((await post("200.00", "2026-12-01")).body.version).toBe(2);
    expect((await post("50.00", "2026-10-01")).body).toEqual({ error: "RETROACTIVE_SETTING" });
    expect((await post(100, "2027-01-01")).status).toBe(400);
    const history = await call(settingsRoute.GET, ids.analyst, { params: A(), query: "?key=MANUAL_RECEIPT_THRESHOLD" });
    expect(history.body.map((v: { version: number; effective_to: string | null }) => [v.version, v.effective_to]))
      .toEqual([[2, null], [1, "2026-11-30"]]);
    expect((await call(settingsRoute.POST, ids.clientMaster,
      { method: "POST", params: A(), body: { key: "ENABLE_TAGS", value: true, effectiveFrom: "2026-12-01" } })).status).toBe(403);
  });

  it("cadastro de equipe, carteira e desativação imediata", async () => {
    const m = ids.master;
    const created = await call(staffUsersRoute.POST, m, { method: "POST", body: { email: "nova@bpo.local", fullName: "Nova" } });
    expect(created.status).toBe(201);
    const assign = (userId: string) => call(staffRoute.POST, m,
      { method: "POST", params: A(), body: { userId, bpoRole: "BPO_ANALYST" } });
    expect((await assign(ids.employee)).body).toEqual({ error: "USER_IS_CLIENT_USER" });
    expect((await assign(created.body.userId)).status).toBe(201);
    expect((await call(entriesRoute.GET, created.body.userId, { params: A() })).status).toBe(200);
    await call(staffUserRoute.PATCH, m, { method: "PATCH", params: { userId: created.body.userId }, body: { isActive: false } });
    expect((await call(entriesRoute.GET, created.body.userId, { params: A() })).status).toBe(403);
  });

  it("Data API do Supabase não alcança as tabelas, e users tem isolamento", async () => {
    const { rows } = await db.admin.query(
      `SELECT r, t.tablename FROM pg_tables t, unnest(ARRAY['anon','authenticated','service_role']) r
        WHERE t.schemaname='public' AND has_table_privilege(r, format('public.%I', t.tablename), 'SELECT,INSERT,UPDATE,DELETE')`);
    expect(rows).toEqual([]);
    expect((await db.app.query("SELECT 1 FROM users")).rowCount).toBe(0);
  });
});
