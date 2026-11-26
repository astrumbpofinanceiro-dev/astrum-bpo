/** Arquivo ainda na fila bloqueia o fechamento, inclusive com ressalva. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as closing from "../../src/app/api/tenants/[tenantId]/closing/route.ts";
import * as validateBalance from "../../src/app/api/tenants/[tenantId]/balance-validations/[accountId]/route.ts";
import { insert } from "./helpers.ts";
import { ofx, testApp, type App } from "./app.ts";

describe("lote em fila x fechamento", () => {
  let app: App;
  beforeEach(async () => { app = await testApp(); });
  afterEach(async () => { await app.close(); });

  const failing = async () => (await app.ok(closing.GET, app.s.reviewer, { query: "?month=2026-11" }))
    .checklist.items.filter((i: { ok: boolean }) => !i.ok).map((i: { code: string }) => i.code);

  it("bloqueia publicação completa e com ressalva até o worker processar", async () => {
    for (const accountId of [app.s.a.bankA, app.s.a.bankB]) {
      await app.ok(validateBalance.POST, app.s.reviewer, { method: "POST", params: { accountId } });
    }
    expect(await failing()).toEqual([]);

    await app.upload(app.s.user, "fila.ofx", ofx("2026-11-03", "2026-11-04", [["2026-11-03", "-10.00", "Q1"]]),
      { docCategory: "BANK_STATEMENT", financialAccountId: app.s.a.bankA });
    // Sem o worker, o lote ainda não tem período: bloqueia todos os meses abertos.
    expect(await failing()).toEqual(["NO_QUEUED_BATCHES"]);
    const full = await app.call(closing.POST, app.s.reviewer, { body: { month: "2026-11" } });
    expect(full.status).toBe(409);
    expect(full.body.error).toBe("CHECKLIST_NO_QUEUED_BATCHES");
    const c = await app.db.admin.connect();
    let issueId: string;
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.current_user_id',$1,true), set_config('app.actor_role','SYSTEM_WORKER',true)", [app.s.user]);
      issueId = await insert(c, "blocking_issues", { tenant_id: app.s.a.id, competence_date: "2026-11-01",
        target_entity_type: "PERIOD_CLOSING", target_entity_id: crypto.randomUUID(), severity: "BLOCKING_OPERATIONAL",
        status: "WAITING_BPO_ACTION", title: "t", description: "d", assigned_to_side: "BPO", opened_by_user_id: app.s.user });
      await c.query("COMMIT");
    } finally { c.release(); }
    const caveat = await app.call(closing.POST, app.s.reviewer, { body: { month: "2026-11",
      caveats: { issueIds: [issueId], justification: "justificativa detalhada do teste", reviewDeadline: "2026-12-15",
        responsibleUserId: app.s.reviewer } } });
    expect(caveat.status).toBe(409);
    expect(caveat.body.error).toBe("CHECKLIST_NO_QUEUED_BATCHES");

    await app.work();
    expect(await failing()).not.toContain("NO_QUEUED_BATCHES");
  });

  it("lote de outro mês não bloqueia novembro", async () => {
    await app.upload(app.s.user, "dez.ofx", ofx("2026-12-03", "2026-12-04", [["2026-12-03", "-10.00", "Q2"]]),
      { docCategory: "BANK_STATEMENT", financialAccountId: app.s.a.bankA });
    await app.work();
    expect(await failing()).not.toContain("NO_QUEUED_BATCHES");
  });
});
