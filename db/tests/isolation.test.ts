import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertUnprivilegedRole } from "../../src/shared/db/tenant-context.ts";
import { as, bankTx, createTestDb, ctx, insert, operation, seed, type Seed, type TestDb } from "./helpers.ts";

describe("isolamento, privilégios e auditoria", () => {
  let db: TestDb;
  let s: Seed;
  beforeAll(async () => { db = await createTestDb(); s = await seed(db); });
  afterAll(async () => { await db.close(); });

  it("sem contexto, a aplicação não vê nenhuma linha", async () => {
    for (const table of ["tenants", "financial_accounts", "audit_logs"]) {
      expect((await db.app.query(`SELECT 1 FROM ${table}`)).rowCount).toBe(0);
    }
  });

  it("cada tenant só vê os próprios dados", async () => {
    const rows = await as(db, ctx(s.user, s.a.id), async (c) =>
      (await c.query("SELECT DISTINCT tenant_id FROM financial_accounts")).rows);
    expect(rows).toEqual([{ tenant_id: s.a.id }]);
  });

  it("bloqueia escrita em outro tenant", async () => {
    await expect(as(db, ctx(s.user, s.a.id), (c) => insert(c, "bank_transactions", bankTx(s.b, "10.00"))))
      .rejects.toThrow(/row-level security/);
  });

  it("FK composta impede referenciar registro de outro tenant", async () => {
    await expect(as(db, ctx(s.user, s.a.id), (c) =>
      insert(c, "bank_transactions", bankTx(s.a, "10.00", { financial_account_id: s.b.bankA }))))
      .rejects.toThrow(/foreign key/);
  });

  it("BPO Master também precisa selecionar tenant", async () => {
    const m = ctx(s.master, null, { actorRole: "BPO_MASTER" });
    await as(db, m, async (c) => {
      expect((await c.query("SELECT 1 FROM tenants")).rowCount).toBe(2);
      expect((await c.query("SELECT 1 FROM financial_accounts")).rowCount).toBe(0);
    });
  });

  it("Master só grava em cliente informando motivo, e o acesso fica marcado", async () => {
    const m = ctx(s.master, s.a.id, { actorRole: "BPO_MASTER" });
    await expect(as(db, m, (c) => insert(c, "tags", { tenant_id: s.a.id, name: "x" })))
      .rejects.toThrow(/IMPERSONATION_REASON_REQUIRED/);
    const id = await as(db, { ...m, impersonationReason: "chamado de suporte" }, (c) =>
      insert(c, "tags", { tenant_id: s.a.id, name: "y" }));
    const { rows } = await db.admin.query(
      "SELECT is_bpo_master_impersonation AS imp, impersonation_reason AS why, source FROM audit_logs WHERE entity_id=$1", [id]);
    expect(rows).toEqual([{ imp: true, why: "chamado de suporte", source: "API" }]);
  });

  it("flag de Master falsificada não tem efeito", async () => {
    await as(db, ctx(s.user, null, { actorRole: "BPO_MASTER" }), async (c) =>
      expect((await c.query("SELECT 1 FROM tenants")).rowCount).toBe(0));
  });

  it("aplicação não promove usuário a Master", async () => {
    await expect(as(db, ctx(s.user, null), (c) => c.query("UPDATE users SET is_bpo_master = true")))
      .rejects.toThrow(/permission denied/);
  });

  it("não apaga registros nem altera a trilha de auditoria", async () => {
    await expect(as(db, ctx(s.user, s.a.id), (c) => c.query("DELETE FROM financial_accounts")))
      .rejects.toThrow(/permission denied/);
    await expect(db.admin.query("UPDATE audit_logs SET reason = 'x'")).rejects.toThrow(/IMMUTABLE_RECORD/);
    await expect(db.admin.query("TRUNCATE audit_logs")).rejects.toThrow(/IMMUTABLE_RECORD/);
  });

  it("recusa escrita sem ator identificado", async () => {
    await expect(db.admin.query("INSERT INTO tags (tenant_id, name) VALUES ($1,'z')", [s.a.id]))
      .rejects.toThrow(/AUDIT_CONTEXT_REQUIRED/);
  });

  it("lançamento do cliente não nasce aprovado", async () => {
    await expect(as(db, ctx(s.user, s.a.id), (c) => insert(c, "economic_operations",
      operation(s.a, s.user, "10.00", { origin_type: "CLIENT_EMPLOYEE_ENTRY", review_status: "APPROVED_FOR_LEDGER" }))))
      .rejects.toThrow(/CLIENT_ENTRY_REQUIRES_BPO_REVIEW/);
  });

  it("guarda de inicialização aceita a role da aplicação e recusa a privilegiada", async () => {
    await expect(assertUnprivilegedRole(db.app)).resolves.toBeUndefined();
    await expect(assertUnprivilegedRole(db.admin)).rejects.toThrow();
  });
});
