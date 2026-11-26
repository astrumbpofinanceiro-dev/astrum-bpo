/** Cartão corporativo: extrato bancário é barrado e a fatura é paga por conciliação N:1. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as operations from "../../src/app/api/tenants/[tenantId]/operations/route.ts";
import * as approve from "../../src/app/api/tenants/[tenantId]/operations/approve/route.ts";
import * as reconciliations from "../../src/app/api/tenants/[tenantId]/reconciliations/route.ts";
import * as reports from "../../src/app/api/tenants/[tenantId]/reports/route.ts";
import { insert } from "./helpers.ts";
import { ofx, testApp, type App } from "./app.ts";

describe("cartão corporativo", () => {
  let app: App;
  beforeEach(async () => { app = await testApp(); });
  afterEach(async () => { await app.close(); });

  const withAudit = async <T>(fn: (c: import("pg").PoolClient) => Promise<T>) => {
    const c = await app.db.admin.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.current_user_id',$1,true), set_config('app.actor_role','SYSTEM_WORKER',true)", [app.s.user]);
      const r = await fn(c);
      await c.query("COMMIT");
      return r;
    } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
  };
  const newCard = () => withAudit((c) => insert(c, "financial_accounts",
    { tenant_id: app.s.a.id, name: "Cartão", account_type: "CORPORATE_CARD", initial_balance_date: "2026-11-01" }));

  it("extrato bancário em conta de cartão é recusado no upload", async () => {
    const card = await newCard();
    await expect(app.upload(app.s.user, "c.ofx", ofx("2026-11-10", "2026-11-10", [["2026-11-10", "-50.00", "K1"]]),
      { docCategory: "BANK_STATEMENT", financialAccountId: card })).rejects.toThrow(/CARD_ACCOUNT_BANK_STATEMENT/);
    expect((await app.rows("SELECT count(*)::int AS n FROM import_batches"))[0].n).toBe(0);
  });

  it("o banco também recusa movimentação bancária movida para conta de cartão", async () => {
    const card = await newCard();
    await app.statement([["2026-11-10", "-50.00", "K2"]]);
    await expect(withAudit((c) => c.query("UPDATE bank_transactions SET financial_account_id = $1", [card])))
      .rejects.toThrow(/CARD_ACCOUNT_BANK_STATEMENT/);
  });

  it("fatura: compras no cartão pagas por um débito bancário (N:1) não contam em dobro", async () => {
    const buy = async (amount: string) => {
      const op = await app.ok(operations.POST, app.s.user, { body: { operationType: "PURCHASE", operationDate: "2026-11-10",
        grossAmount: amount, description: "Compra no cartão", installments: [{ dueDate: "2026-12-10" }] } });
      return op as { id: string; installmentIds: string[] };
    };
    const a = await buy("100.00");
    const b = await buy("200.00");
    await app.ok(approve.POST, app.s.reviewer, { body: { operationIds: [a.id, b.id] } });
    const [debit] = await app.statement([["2026-12-10", "-300.00", "FAT1"]]);
    await app.ok(reconciliations.POST, app.s.user, { body: { allocations: [
      { movementType: "BANK_TRANSACTION", movementId: debit, targetType: "OBLIGATION_INSTALLMENT", targetId: a.installmentIds[0], amount: "100.00" },
      { movementType: "BANK_TRANSACTION", movementId: debit, targetType: "OBLIGATION_INSTALLMENT", targetId: b.installmentIds[0], amount: "200.00" },
    ] } });
    const nov = await app.ok(reports.GET, app.s.user, { query: "?month=2026-11" });
    const dec = await app.ok(reports.GET, app.s.user, { query: "?month=2026-12" });
    expect(nov.competence.costsAndExpenses).toBe("300.00");
    expect(nov.cash.outflows).toBe("0.00");
    expect(dec.cash.outflows).toBe("300.00");
    expect(dec.competence.costsAndExpenses).toBe("0.00");
  });
});
