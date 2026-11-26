import { describe, expect, it } from "vitest";
import { can, type Access, type Scope } from "../../src/modules/identity-access/authorize.ts";
import type { Role } from "../../src/modules/identity-access/permissions.ts";

const scope: Scope = {
  businessUnitId: "u1", financialAccountId: null, canUploadDocuments: true, canCreateManualEntries: true,
  allowedEntryTypes: ["CASH_EXPENSE"], maxEntryAmount: "100.00", canViewReports: true, canViewBankBalances: true,
};
const access = (role: Role, extra: Partial<Access> = {}): Access =>
  ({ userId: "me", tenantId: "t", roles: [role], blindMode: false, scopes: [], ...extra });
const employee = (blindMode = true) => access("CLIENT_EMPLOYEE", { blindMode, scopes: [scope] });

describe("matriz de permissões", () => {
  it("analista não publica, não aprova nem reabre; revisor sim", () => {
    for (const p of ["closing.publish", "closing.reopen", "closing.publish_with_caveats", "entries.approve", "issues.validate"] as const) {
      expect(can(access("BPO_ANALYST"), p), p).toBe(false);
      expect(can(access("BPO_REVIEWER"), p), p).toBe(true);
      expect(can(access("CLIENT_MASTER"), p), p).toBe(false);
    }
  });
  it("funcionário: tipo, valor máximo e unidade do escopo", () => {
    const create = (r: object) => can(employee(), "entries.create",
      { businessUnitId: "u1", entryType: "CASH_EXPENSE", amount: "100.00", ...r });
    expect(create({})).toBe(true);
    expect(create({ amount: "100.01" })).toBe(false);
    expect(create({ entryType: "DAILY_SALES_SUMMARY" })).toBe(false);
    expect(create({ businessUnitId: "u2" })).toBe(false);
    expect(create({ businessUnitId: null })).toBe(false);
  });
  it("funcionário edita só o próprio, em rascunho ou devolvido", () => {
    const edit = (status: string, ownerUserId = "me") =>
      can(employee(), "entries.edit", { businessUnitId: "u1", status, ownerUserId });
    expect(edit("DRAFT")).toBe(true);
    expect(edit("RETURNED_FOR_CORRECTION")).toBe(true);
    expect(edit("SUBMITTED_PENDING_BPO")).toBe(false);
    expect(edit("DRAFT", "outro")).toBe(false);
  });
  it("Modo Cego prevalece sobre as marcações do escopo; sem escopo não há acesso", () => {
    expect(can(employee(true), "reports.view")).toBe(false);
    expect(can(employee(true), "balances.view")).toBe(false);
    expect(can(employee(false), "balances.view")).toBe(true);
    expect(can(access("CLIENT_EMPLOYEE"), "entries.view")).toBe(false);
  });
});

describe("documento da empresa", () => {
  it("aceita CPF, CNPJ numérico e alfanumérico", async () => {
    const { tenantInput } = await import("../../src/modules/tenants-config/structure.ts");
    const ok = (taxId: string) =>
      tenantInput.safeParse({ legalName: "a", tradeName: "a", taxId, segmentCode: "RETAIL" }).success;
    expect(["12345678901", "12345678000190", "12ABC34501DE35"].every(ok)).toBe(true);
    expect(["12abc34501de35", "12ABC34501DEXX", "123"].some(ok)).toBe(false);
  });
});
