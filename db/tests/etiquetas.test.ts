/** Etiquetas de contrato: várias operações compartilham o código e o resultado fecha por etiqueta. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as tags from "../../src/app/api/tenants/[tenantId]/tags/route.ts";
import * as tag from "../../src/app/api/tenants/[tenantId]/tags/[tagId]/route.ts";
import * as tagReport from "../../src/app/api/tenants/[tenantId]/tag-report/route.ts";
import * as operations from "../../src/app/api/tenants/[tenantId]/operations/route.ts";
import * as approve from "../../src/app/api/tenants/[tenantId]/operations/approve/route.ts";
import * as support from "../../src/app/api/support-sessions/route.ts";
import { testApp, type App } from "./app.ts";

describe("etiquetas de contrato", () => {
  let app: App;
  beforeEach(async () => {
    app = await testApp();
    await app.ok(support.POST, app.s.master, { body: { tenantId: app.s.a.id, reason: "Cadastro inicial do cliente" } });
  });
  afterEach(async () => { await app.close(); });

  const newTag = (name: string) => app.ok(tags.POST, app.s.master, { body: { name, color: "#3F6B48" } }) as Promise<{ id: string }>;
  const op = (type: string, amount: string, tagId?: string) => app.ok(operations.POST, app.s.user, { body: {
    operationType: type, operationDate: "2026-11-10", grossAmount: amount, description: "Mensalidade",
    installments: [{ dueDate: "2026-12-10" }], ...(tagId && { tagId }) } }) as Promise<{ id: string }>;

  it("20 recebimentos do mesmo contrato somam na etiqueta; o resto fica em 'sem etiqueta'", async () => {
    const turma = await newTag("Medicina XXVII – Bruna");
    const outra = await newTag("Direito III – Carlos");
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) ids.push((await op("SERVICE", "500.00", turma.id)).id);
    ids.push((await op("EXPENSE", "1500.00", turma.id)).id);
    ids.push((await op("SERVICE", "300.00", outra.id)).id);
    ids.push((await op("SERVICE", "100.00")).id);
    await app.ok(approve.POST, app.s.reviewer, { body: { operationIds: ids } });

    const all = await app.ok(tagReport.GET, app.s.user, {}) as any;
    const t = all.tags.find((x: any) => x.name.startsWith("Medicina"));
    expect(t).toMatchObject({ operations: 21, revenue: "10000.00", costs: "1500.00", result: "8500.00" });
    expect(all.tags.find((x: any) => x.name.startsWith("Direito"))).toMatchObject({ revenue: "300.00" });
    expect(all.untagged).toMatchObject({ operations: 1, revenue: "100.00" });
    const sum = all.tags.reduce((s: number, x: any) => s + Number(x.revenue), 0) + Number(all.untagged.revenue);
    expect(sum).toBe(10400); // fecha com a receita total

    expect(((await app.ok(tagReport.GET, app.s.user, { query: "?month=2026-12" })) as any).tags).toEqual([]);
  });

  it("não conta operação pendente de aprovação", async () => {
    const turma = await newTag("Turma A");
    await op("SERVICE", "500.00", turma.id);
    expect(((await app.ok(tagReport.GET, app.s.user, {})) as any).tags).toEqual([]);
  });

  it("nome repetido, cor inválida, etiqueta de outra empresa e permissões", async () => {
    await newTag("Turma A");
    expect((await app.call(tags.POST, app.s.master, { body: { name: "turma a" } })).status).toBe(409);
    expect((await app.call(tags.POST, app.s.master, { body: { name: "X", color: "vermelho" } })).status).toBe(400);
    for (const user of [app.s.user, app.s.reviewer, app.ids.owner]) {
      expect((await app.call(tags.POST, user, { body: { name: "Y" } })).status).toBe(403);
    }
    expect((await app.call(operations.POST, app.s.user, { body: { operationType: "SERVICE", operationDate: "2026-11-10",
      grossAmount: "10.00", description: "Teste", tagId: crypto.randomUUID(), installments: [{ dueDate: "2026-12-10" }] } })).status).toBe(400);
    const t = await newTag("Turma B");
    const r = await app.call(tag.PATCH, app.s.master, { params: { tagId: t.id }, body: { name: "Turma B2", isActive: false } });
    expect(r.body).toMatchObject({ name: "Turma B2", is_active: false });
    expect((await app.call(tagReport.GET, app.ids.employee, {})).status).toBe(403);
  });
});
