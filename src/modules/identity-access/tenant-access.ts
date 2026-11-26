import { randomUUID } from "node:crypto";
import type pg from "pg";
import { withContext, type RequestContext } from "../../shared/db/tenant-context";
import { AppError, forbidden } from "../../shared/errors";
import { logDeniedAccess } from "../audit/index";
import { assertCan, type Access, type Resource, type Scope } from "./authorize";
import { ROLE_PRIORITY, type Permission, type Role } from "./permissions";
import type { Principal } from "./principal";
import { findSupportSession } from "./support-session";

export interface TenantAccess extends Access {
  supportReason?: string;
}

function primaryRole(p: Principal): RequestContext["actorRole"] {
  if (p.isBpoMaster) return "BPO_MASTER";
  const roles: Role[] = [...p.assignments.map((a) => a.role), ...p.memberships.map((m) => m.role)];
  return ROLE_PRIORITY.find((r) => roles.includes(r)) ?? "NO_ROLE";
}

async function resolve(pool: pg.Pool, principal: Principal, tenantId: string): Promise<TenantAccess | null> {
  const base = { userId: principal.userId, tenantId, blindMode: false, scopes: [] as Scope[] };
  if (principal.isBpoMaster) {
    const session = await findSupportSession(pool, principal.userId, tenantId);
    if (!session) throw new AppError(403, "SUPPORT_SESSION_REQUIRED");
    return { ...base, roles: ["BPO_MASTER"], supportReason: session.reason };
  }
  const assignments = principal.assignments.filter((a) => a.tenantId === tenantId);
  const membership = principal.memberships.find((m) => m.tenantId === tenantId);
  // Equipe BPO e usuário do cliente no mesmo tenant é conflito: nega.
  if (assignments.length > 0 && membership) return null;
  if (assignments.length > 0) return { ...base, roles: assignments.map((a) => a.role) };
  if (!membership) return null;
  if (membership.role === "CLIENT_MASTER") return { ...base, roles: ["CLIENT_MASTER"] };

  const scopes = await withContext(
    pool, { userId: principal.userId, tenantId, actorRole: "CLIENT_EMPLOYEE", source: "API" },
    async (c) => (await c.query(
      `SELECT business_unit_id, financial_account_id, can_upload_documents, can_create_manual_entries,
              allowed_entry_types::text[] AS allowed_entry_types, max_entry_amount, can_view_reports, can_view_bank_balances
         FROM user_scopes WHERE tenant_id = $1 AND membership_id = $2`,
      [tenantId, membership.membershipId])).rows);
  return {
    ...base,
    roles: ["CLIENT_EMPLOYEE"],
    blindMode: membership.blindMode,
    scopes: scopes.map((s) => ({
      businessUnitId: s.business_unit_id, financialAccountId: s.financial_account_id,
      canUploadDocuments: s.can_upload_documents, canCreateManualEntries: s.can_create_manual_entries,
      allowedEntryTypes: s.allowed_entry_types, maxEntryAmount: s.max_entry_amount,
      canViewReports: s.can_view_reports, canViewBankBalances: s.can_view_bank_balances,
    })),
  };
}

/**
 * Único caminho para operar dados de um cliente: valida vínculo e permissão e
 * abre a transação com o contexto de RLS. Toda negativa fica registrada.
 */
export async function inTenant<T>(
  pool: pg.Pool,
  principal: Principal,
  tenantId: string,
  request: { permission: Permission; resource?: Resource; changeReason?: string },
  work: (client: pg.PoolClient, access: TenantAccess) => Promise<T>,
): Promise<T> {
  try {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenantId)) throw forbidden();
    const access = await resolve(pool, principal, tenantId.toLowerCase());
    if (!access) throw forbidden();
    const role = assertCan(access, request.permission, request.resource);
    return await withContext(pool, {
      userId: principal.userId, tenantId: access.tenantId, actorRole: role, source: "API",
      correlationId: randomUUID(), impersonationReason: access.supportReason, changeReason: request.changeReason,
    }, (client) => work(client, access));
  } catch (error) {
    if (error instanceof AppError && error.status === 403) {
      await logDeniedAccess(pool, principal.userId, primaryRole(principal), tenantId);
    }
    throw error;
  }
}
