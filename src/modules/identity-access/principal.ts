import type pg from "pg";
import { withIdentity } from "../../shared/db/tenant-context";
import { forbidden, mfaRequired } from "../../shared/errors";
import type { BpoRole, ClientRole } from "./permissions";

/** Resultado da verificação do token no provedor (nunca vem do navegador sem validação). */
export interface VerifiedSession {
  userId: string;
  aal: "aal1" | "aal2";
  hasVerifiedFactor: boolean;
}

export interface Principal {
  userId: string;
  email: string;
  fullName: string;
  isBpoMaster: boolean;
  memberships: { tenantId: string; membershipId: string; role: ClientRole; blindMode: boolean }[];
  assignments: { tenantId: string; role: BpoRole }[];
}

export async function loadPrincipal(pool: pg.Pool, userId: string): Promise<Principal> {
  return withIdentity(pool, userId, async (c) => {
    const user = (await c.query(
      "SELECT email, full_name, is_bpo_master FROM users WHERE id = $1 AND is_active", [userId])).rows[0];
    if (!user) throw forbidden();
    // Filtro por user_id é obrigatório (política own_*).
    const memberships = (await c.query(
      "SELECT tenant_id, id, client_role, is_blind_mode FROM tenant_memberships WHERE user_id = $1 AND is_active",
      [userId])).rows;
    const assignments = (await c.query(
      "SELECT tenant_id, bpo_role FROM bpo_staff_assignments WHERE user_id = $1 AND revoked_at IS NULL", [userId])).rows;
    return {
      userId,
      email: user.email,
      fullName: user.full_name,
      isBpoMaster: user.is_bpo_master,
      memberships: memberships.map((m) => ({
        tenantId: m.tenant_id, membershipId: m.id, role: m.client_role, blindMode: m.is_blind_mode,
      })),
      assignments: assignments.map((a) => ({ tenantId: a.tenant_id, role: a.bpo_role })),
    };
  });
}

/** MFA obrigatório para a equipe BPO e o Master Cliente; e para quem já cadastrou um fator. */
export function requiresMfa(principal: Principal, hasVerifiedFactor: boolean): boolean {
  return hasVerifiedFactor || principal.isBpoMaster || principal.assignments.length > 0 ||
    principal.memberships.some((m) => m.role === "CLIENT_MASTER");
}

export async function authenticate(pool: pg.Pool, session: VerifiedSession): Promise<Principal> {
  const principal = await loadPrincipal(pool, session.userId);
  if (session.aal !== "aal2" && requiresMfa(principal, session.hasVerifiedFactor)) throw mfaRequired();
  return principal;
}
