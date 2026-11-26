/** Gestão de usuários nos quatro níveis (Doc 1 §3). */
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { z } from "zod";
import { withContext, withIdentity } from "../../shared/db/tenant-context";
import { conflict, forbidden } from "../../shared/errors";
import { money } from "../../shared/money/money";
import { DEFAULT_GRANT_LIMITS, resolveSetting, today, type GrantLimits } from "../tenants-config/settings";
import type { IdentityProvider } from "./identity-provider";
import type { Principal } from "./principal";
import { inTenant, type TenantAccess } from "./tenant-access";

const email = z.email().max(255).transform((v) => v.toLowerCase());
const fullName = z.string().trim().min(1).max(150);

export const scopeInput = z.strictObject({
  businessUnitId: z.guid().nullable().default(null),
  financialAccountId: z.guid().nullable().default(null),
  canUploadDocuments: z.boolean().default(true),
  canCreateManualEntries: z.boolean().default(false),
  allowedEntryTypes: z.array(z.string().regex(/^[A-Z_]{1,50}$/)).default([]),
  maxEntryAmount: z.string().regex(/^\d{1,13}(\.\d{1,2})?$/).nullable().default(null),
  canViewReports: z.boolean().default(false),
  canViewBankBalances: z.boolean().default(false),
});
export type ScopeInput = z.infer<typeof scopeInput>;

async function assertEmailFree(c: pg.PoolClient, address: string) {
  const { rows } = await c.query("SELECT app.email_registered($1) AS used", [address]);
  if (rows[0].used) throw conflict("USER_CANNOT_BE_INVITED");
}

/** Remove a conta recém-criada. Colisão de chave significa que ela já existia: não apagar. */
async function compensate(idp: IdentityProvider, userId: string, error: unknown) {
  if ((error as { code?: string }).code !== "23505") await idp.remove(userId);
}

export const clientUserInput = z.strictObject({
  email, fullName,
  clientRole: z.enum(["CLIENT_MASTER", "CLIENT_EMPLOYEE"]),
  isBlindMode: z.boolean().optional(),
  scopes: z.array(scopeInput).max(50).default([]),
});
export const membershipPatch = z.strictObject({ isActive: z.boolean().optional(), isBlindMode: z.boolean().optional() });
export const staffUserInput = z.strictObject({ email, fullName });
export const assignmentInput = z.strictObject({
  userId: z.guid(), bpoRole: z.enum(["BPO_ANALYST", "BPO_REVIEWER", "BPO_AUDITOR"]),
});

async function limitsFor(c: pg.PoolClient, access: TenantAccess): Promise<GrantLimits | null> {
  if (access.roles.includes("BPO_MASTER")) return null; // sem limite
  return (await resolveSetting(c, access.tenantId, "CLIENT_GRANT_LIMITS", today())) ?? DEFAULT_GRANT_LIMITS;
}

function assertWithinLimits(limits: GrantLimits | null, blind: boolean | undefined, scopes: ScopeInput[]) {
  if (!limits) return;
  if (blind === false && !limits.canDisableBlindMode) throw forbidden();
  for (const s of scopes) {
    if (s.canViewReports && !limits.canGrantReports) throw forbidden();
    if (s.canViewBankBalances && !limits.canGrantBankBalances) throw forbidden();
    if (limits.maxEntryAmount !== null && s.canCreateManualEntries &&
        (s.maxEntryAmount === null || money(s.maxEntryAmount).greaterThan(money(limits.maxEntryAmount)))) {
      throw forbidden();
    }
  }
}

async function insertScopes(c: pg.PoolClient, tenantId: string, membershipId: string, scopes: ScopeInput[]) {
  for (const s of scopes) {
    await c.query(
      `INSERT INTO user_scopes (tenant_id, membership_id, business_unit_id, financial_account_id, can_upload_documents,
         can_create_manual_entries, allowed_entry_types, max_entry_amount, can_view_reports, can_view_bank_balances)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [tenantId, membershipId, s.businessUnitId, s.financialAccountId, s.canUploadDocuments,
       s.canCreateManualEntries, s.allowedEntryTypes, s.maxEntryAmount, s.canViewReports, s.canViewBankBalances]);
  }
}

export async function createClientUser(
  pool: pg.Pool, idp: IdentityProvider, principal: Principal, tenantId: string, raw: unknown,
): Promise<{ userId: string; membershipId: string }> {
  const input = clientUserInput.parse(raw);
  const employee = input.clientRole === "CLIENT_EMPLOYEE";
  const blind = employee ? (input.isBlindMode ?? true) : false;

  // 1) Autoriza ANTES de acionar o provedor de identidade.
  const existingId = await inTenant(pool, principal, tenantId, { permission: "client_users.manage" }, async (c, access) => {
    const limits = await limitsFor(c, access);
    if (limits && !employee) throw forbidden(); // Master Cliente só cria funcionário
    assertWithinLimits(limits, employee ? blind : undefined, input.scopes);
    const found = (await c.query("SELECT id, is_bpo_master FROM users WHERE email = $1", [input.email])).rows[0];
    if (!found) {
      await assertEmailFree(c, input.email); // pode existir em outro cliente
      return null;
    }
    // Somente o Master BPO reaproveita um usuário já cadastrado.
    if (!access.roles.includes("BPO_MASTER") || found.is_bpo_master) throw conflict("USER_CANNOT_BE_INVITED");
    const staff = await c.query(
      "SELECT 1 FROM bpo_staff_assignments WHERE tenant_id = $1 AND user_id = $2 AND revoked_at IS NULL",
      [tenantId, found.id]);
    if (staff.rowCount) throw conflict("USER_IS_BPO_STAFF_OF_TENANT");
    return found.id as string;
  });

  const userId = existingId ?? (await idp.invite(input.email, input.fullName));
  try {
    return await inTenant(pool, principal, tenantId, { permission: "client_users.manage" }, async (c) => {
      // Sem RETURNING: a linha só fica visível depois de criado o vínculo.
      if (!existingId) {
        await c.query("INSERT INTO users (id, email, full_name) VALUES ($1,$2,$3)", [userId, input.email, input.fullName]);
      }
      const membershipId = randomUUID();
      await c.query(
        "INSERT INTO tenant_memberships (id, tenant_id, user_id, client_role, is_blind_mode) VALUES ($1,$2,$3,$4,$5)",
        [membershipId, tenantId, userId, input.clientRole, blind]);
      if (employee) await insertScopes(c, tenantId, membershipId, input.scopes);
      return { userId, membershipId };
    });
  } catch (error) {
    if (!existingId) await compensate(idp, userId, error);
    throw error;
  }
}

/** Alvo de um Master Cliente só pode ser funcionário (nunca ele mesmo ou outro Master). */
async function targetMembership(c: pg.PoolClient, access: TenantAccess, membershipId: string) {
  const row = (await c.query(
    "SELECT id, user_id, client_role, is_blind_mode FROM tenant_memberships WHERE tenant_id = $1 AND id = $2",
    [access.tenantId, z.guid().parse(membershipId)])).rows[0];
  if (!row) throw forbidden();
  if (!access.roles.includes("BPO_MASTER") && row.client_role !== "CLIENT_EMPLOYEE") throw forbidden();
  return row;
}

export async function updateMembership(
  pool: pg.Pool, principal: Principal, tenantId: string, membershipId: string, raw: unknown,
) {
  const patch = membershipPatch.parse(raw);
  await inTenant(pool, principal, tenantId, { permission: "client_users.manage" }, async (c, access) => {
    const target = await targetMembership(c, access, membershipId);
    if (patch.isBlindMode === false) assertWithinLimits(await limitsFor(c, access), false, []);
    await c.query(
      "UPDATE tenant_memberships SET is_active = COALESCE($2, is_active), is_blind_mode = COALESCE($3, is_blind_mode) WHERE id = $1",
      [target.id, patch.isActive ?? null, patch.isBlindMode ?? null]);
  });
}

export async function replaceScopes(
  pool: pg.Pool, principal: Principal, tenantId: string, membershipId: string, raw: unknown,
) {
  const scopes = z.array(scopeInput).max(50).parse(raw);
  await inTenant(pool, principal, tenantId, { permission: "client_users.manage" }, async (c, access) => {
    const target = await targetMembership(c, access, membershipId);
    if (target.client_role !== "CLIENT_EMPLOYEE") throw conflict("SCOPES_ONLY_FOR_EMPLOYEE");
    assertWithinLimits(await limitsFor(c, access), undefined, scopes);
    await c.query("DELETE FROM user_scopes WHERE tenant_id = $1 AND membership_id = $2", [tenantId, target.id]);
    await insertScopes(c, tenantId, target.id, scopes);
  });
}

export async function listClientUsers(c: pg.PoolClient, tenantId: string) {
  return (await c.query(
    `SELECT m.id AS membership_id, u.id AS user_id, u.email, u.full_name, m.client_role, m.is_blind_mode, m.is_active
       FROM tenant_memberships m JOIN users u ON u.id = m.user_id WHERE m.tenant_id = $1 ORDER BY u.full_name`,
    [tenantId])).rows;
}

const globalMaster = (userId: string) =>
  ({ userId, tenantId: null, actorRole: "BPO_MASTER", source: "API" }) as const;

/** Usuário interno do BPO (sem carteira até ser atribuído). */
export async function createStaffUser(pool: pg.Pool, idp: IdentityProvider, principal: Principal, raw: unknown) {
  if (!principal.isBpoMaster) throw forbidden();
  const input = staffUserInput.parse(raw);
  await withContext(pool, globalMaster(principal.userId), (c) => assertEmailFree(c, input.email));
  const userId = await idp.invite(input.email, input.fullName);
  try {
    await withContext(pool, globalMaster(principal.userId), (c) =>
      c.query("INSERT INTO users (id, email, full_name) VALUES ($1,$2,$3)", [userId, input.email, input.fullName]));
  } catch (error) {
    await compensate(idp, userId, error);
    throw error;
  }
  return { userId };
}

/** Desativação global: o próximo pedido do usuário já é recusado. */
export async function setUserActive(pool: pg.Pool, principal: Principal, userId: string, isActive: boolean) {
  if (!principal.isBpoMaster) throw forbidden();
  const id = z.guid().parse(userId);
  if (id === principal.userId) throw conflict("CANNOT_CHANGE_OWN_STATUS");
  await withContext(pool, globalMaster(principal.userId), async (c) => {
    const r = await c.query("UPDATE users SET is_active = $2 WHERE id = $1 AND NOT is_bpo_master", [id, isActive]);
    if (!r.rowCount) throw forbidden();
  });
}

export async function assignStaff(pool: pg.Pool, principal: Principal, tenantId: string, raw: unknown) {
  const input = assignmentInput.parse(raw);
  if (!principal.isBpoMaster) {
    // Deixa o inTenant negar e registrar a tentativa.
    return inTenant<{ id: string }>(pool, principal, tenantId, { permission: "staff.manage" }, async () => {
      throw forbidden();
    });
  }
  // Usuário de qualquer cliente não vira equipe interna.
  const isClientUser = await withIdentity(pool, input.userId, async (own) =>
    (await own.query("SELECT 1 FROM tenant_memberships WHERE user_id = $1", [input.userId])).rowCount);
  return inTenant(pool, principal, tenantId, { permission: "staff.manage" }, async (c) => {
    const user = (await c.query("SELECT is_bpo_master FROM users WHERE id = $1 AND is_active", [input.userId])).rows[0];
    if (!user || user.is_bpo_master) throw conflict("USER_CANNOT_BE_ASSIGNED");
    if (isClientUser) throw conflict("USER_IS_CLIENT_USER");
    return (await c.query(
      "INSERT INTO bpo_staff_assignments (user_id, tenant_id, bpo_role) VALUES ($1,$2,$3) RETURNING id",
      [input.userId, tenantId, input.bpoRole])).rows[0] as { id: string };
  });
}

export async function revokeStaff(pool: pg.Pool, principal: Principal, tenantId: string, assignmentId: string) {
  await inTenant(pool, principal, tenantId, { permission: "staff.manage" }, async (c) => {
    const r = await c.query(
      "UPDATE bpo_staff_assignments SET revoked_at = now() WHERE tenant_id = $1 AND id = $2 AND revoked_at IS NULL",
      [tenantId, z.guid().parse(assignmentId)]);
    if (!r.rowCount) throw forbidden();
  });
}

export async function listStaff(c: pg.PoolClient, tenantId: string) {
  return (await c.query(
    `SELECT a.id AS assignment_id, u.id AS user_id, u.email, u.full_name, a.bpo_role, a.assigned_at, a.revoked_at
       FROM bpo_staff_assignments a JOIN users u ON u.id = a.user_id WHERE a.tenant_id = $1 ORDER BY u.full_name`,
    [tenantId])).rows;
}
