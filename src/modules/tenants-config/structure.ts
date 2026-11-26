/** Empresas, unidades, contas e adquirentes. A autorização é feita por quem chama (inTenant). */
import type pg from "pg";
import { z } from "zod";
import type { Access } from "../identity-access/authorize";
import { can } from "../identity-access/authorize";

const name = z.string().trim().min(1);
const amount = z.string().regex(/^-?\d{1,13}(\.\d{1,2})?$/);

export const tenantInput = z.strictObject({
  legalName: name.max(200), tradeName: name.max(200), // CPF (11 dígitos) ou CNPJ, inclusive o alfanumérico (12 posições A-Z/0-9 + 2 dígitos).
  // Dígitos verificadores não são conferidos aqui.
  taxId: z.string().regex(/^(\d{11}|[0-9A-Z]{12}\d{2})$/),
  segmentCode: z.enum(["FOOD_SERVICE", "RETAIL", "SERVICES"]),
});
export const tenantPatch = z.strictObject({
  legalName: name.max(200).optional(), tradeName: name.max(200).optional(),
  status: z.enum(["ONBOARDING", "ACTIVE", "SUSPENDED", "CLOSED"]).optional(),
});
export const unitInput = z.strictObject({ name: name.max(120), code: name.max(30).nullable().default(null) });
export const accountInput = z.strictObject({
  name: name.max(120),
  accountType: z.enum(["BANK_CHECKING", "CASH_PHYSICAL", "CORPORATE_CARD"]),
  businessUnitId: z.guid().nullable().default(null),
  bankCode: name.max(10).nullable().default(null),
  initialBalance: amount,
  initialBalanceDate: z.iso.date(),
});
export const acquirerInput = z.strictObject({ name: name.max(80), settlementAccountId: z.guid() });

export async function listUnits(c: pg.PoolClient, access: Access) {
  const rows = (await c.query(
    "SELECT id, name, code, is_active FROM business_units WHERE tenant_id = $1 ORDER BY name", [access.tenantId])).rows;
  return rows.filter((u) => can(access, "structure.view", { businessUnitId: u.id }));
}

export async function createUnit(c: pg.PoolClient, tenantId: string, raw: unknown) {
  const i = unitInput.parse(raw);
  return (await c.query(
    "INSERT INTO business_units (tenant_id, name, code) VALUES ($1,$2,$3) RETURNING id, name, code, is_active",
    [tenantId, i.name, i.code])).rows[0];
}

/** Nunca devolve saldo: saldos saem apenas por listBalances. */
export async function listAccounts(c: pg.PoolClient, access: Access) {
  const rows = (await c.query(
    `SELECT id, name, account_type, bank_code, business_unit_id, is_active
       FROM financial_accounts WHERE tenant_id = $1 ORDER BY name`, [access.tenantId])).rows;
  return rows.filter((a) =>
    can(access, "structure.view", { businessUnitId: a.business_unit_id, financialAccountId: a.id }));
}

/**
 * Saldo INICIAL cadastrado. O saldo corrente depende do motor financeiro (Etapa 4).
 */
export async function listBalances(c: pg.PoolClient, access: Access) {
  const rows = (await c.query(
    `SELECT id, name, business_unit_id, initial_balance, initial_balance_date
       FROM financial_accounts WHERE tenant_id = $1 ORDER BY name`, [access.tenantId])).rows;
  return rows.filter((a) =>
    can(access, "balances.view", { businessUnitId: a.business_unit_id, financialAccountId: a.id }));
}

export async function createAccount(c: pg.PoolClient, tenantId: string, raw: unknown) {
  const i = accountInput.parse(raw);
  return (await c.query(
    `INSERT INTO financial_accounts (tenant_id, name, account_type, business_unit_id, bank_code, initial_balance, initial_balance_date)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, name, account_type`,
    [tenantId, i.name, i.accountType, i.businessUnitId, i.bankCode, i.initialBalance, i.initialBalanceDate])).rows[0];
}

export async function listAcquirers(c: pg.PoolClient, tenantId: string) {
  return (await c.query(
    "SELECT id, name, settlement_account_id FROM acquirers WHERE tenant_id = $1 ORDER BY name", [tenantId])).rows;
}

export async function createAcquirer(c: pg.PoolClient, tenantId: string, raw: unknown) {
  const i = acquirerInput.parse(raw);
  return (await c.query(
    "INSERT INTO acquirers (tenant_id, name, settlement_account_id) VALUES ($1,$2,$3) RETURNING id, name",
    [tenantId, i.name, i.settlementAccountId])).rows[0];
}
