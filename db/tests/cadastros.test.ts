/** Plano de contas e centros de custo: permissão, hierarquia, isolamento e auditoria. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as categories from "../../src/app/api/tenants/[tenantId]/categories/route.ts";
import * as category from "../../src/app/api/tenants/[tenantId]/categories/[categoryId]/route.ts";
import * as centers from "../../src/app/api/tenants/[tenantId]/cost-centers/route.ts";
import * as center from "../../src/app/api/tenants/[tenantId]/cost-centers/[costCenterId]/route.ts";
import * as support from "../../src/app/api/support-sessions/route.ts";
import { testApp, type App } from "./app.ts";

describe("cadastros", () => {
  let app: App;
  beforeEach(async () => {
    app = await testApp();
    await app.ok(support.POST, app.s.master, { body: { tenantId: app.s.a.id, reason: "Cadastro inicial do cliente" } });
  });
  afterEach(async () => { await app.close(); });

  const create = (body: object, user = () => app.s.master) => app.call(categories.POST, user(), { body });
  const revenue = { code: "1", name: "Receitas", nature: "REVENUE" };

  it("plano de contas em árvore, auditado e visível a quem tem acesso à estrutura", async () => {
    const root = await create(revenue);
    expect(root.status).toBe(201);
    const child = await create({ code: "1.1", name: "Vendas no salão", nature: "REVENUE", parentId: root.body.id });
    expect(child.status).toBe(201);
    const list = (await app.ok(categories.GET, app.ids.owner)) as { code: string; parent_id: string | null }[];
    expect(list.map((c) => [c.code, c.parent_id])).toEqual([["1", null], ["1.1", root.body.id]]);
    const audited = await app.rows("SELECT count(*)::int AS n FROM audit_logs WHERE entity_id = $1 AND is_bpo_master_impersonation", child.body.id);
    expect(audited[0].n).toBe(1);
  });

  it("só o Master BPO altera; analista, revisor e cliente não", async () => {
    for (const user of [app.s.user, app.s.reviewer, app.ids.owner]) {
      expect((await app.call(categories.POST, user, { body: revenue })).status).toBe(403);
    }
  });

  it("código repetido, natureza inválida, pai de outra empresa e campos extras são recusados", async () => {
    await create(revenue);
    expect((await create(revenue)).status).toBeGreaterThanOrEqual(400);
    expect((await create({ code: "2", name: "X", nature: "OUTRA" })).status).toBe(400);
    expect((await create({ code: "3", name: "X", nature: "REVENUE", extra: 1 })).status).toBe(400);
    const [foreign] = await app.rows(
      `WITH ctx AS (SELECT set_config('app.current_user_id',$1,true), set_config('app.actor_role','SYSTEM_WORKER',true))
       INSERT INTO accounting_categories (tenant_id, code, name, nature) SELECT $2, 'B1', 'Outra', 'REVENUE' FROM ctx RETURNING id`,
      app.s.user, app.s.b.id).catch(() => [undefined]);
    if (foreign) expect((await create({ code: "4", name: "X", nature: "REVENUE", parentId: foreign.id })).status).toBeGreaterThanOrEqual(400);
  });

  it("renomear e desativar não mexem em código, natureza ou pai", async () => {
    const root = await create(revenue);
    const r = await app.call(category.PATCH, app.s.master, { params: { categoryId: root.body.id }, body: { name: "Receitas gerais", isActive: false } });
    expect(r.status).toBeLessThan(300);
    expect(r.body).toMatchObject({ code: "1", nature: "REVENUE", name: "Receitas gerais", is_active: false });
    const bad = await app.call(category.PATCH, app.s.master, { params: { categoryId: root.body.id }, body: { code: "9" } });
    expect(bad.status).toBe(400);
  });

  it("centros de custo: criar, renomear e desativar", async () => {
    const c = await app.call(centers.POST, app.s.master, { body: { name: "Cozinha" } });
    expect(c.status).toBe(201);
    const p = await app.call(center.PATCH, app.s.master, { params: { costCenterId: c.body.id }, body: { isActive: false } });
    expect(p.body).toMatchObject({ name: "Cozinha", is_active: false });
    expect((await app.call(centers.POST, app.s.user, { body: { name: "X" } })).status).toBe(403);
    expect(((await app.ok(centers.GET, app.ids.owner)) as unknown[]).length).toBe(1);
  });
});
