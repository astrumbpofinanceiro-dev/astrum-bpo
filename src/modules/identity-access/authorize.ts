import { money } from "../../shared/money/money";
import { forbidden } from "../../shared/errors";
import { PERMISSIONS, ROLE_PRIORITY, type Permission, type Role } from "./permissions";

export interface Scope {
  businessUnitId: string | null;
  financialAccountId: string | null;
  canUploadDocuments: boolean;
  canCreateManualEntries: boolean;
  allowedEntryTypes: string[];
  maxEntryAmount: string | null;
  canViewReports: boolean;
  canViewBankBalances: boolean;
}

export interface Access {
  userId: string;
  tenantId: string;
  roles: Role[];
  blindMode: boolean;
  scopes: Scope[];
}

/**
 * undefined = dimensão não se aplica ao registro/consulta;
 * null = o registro não tem unidade/conta (só escopo sem restrição enxerga).
 */
export interface Resource {
  businessUnitId?: string | null;
  financialAccountId?: string | null;
  ownerUserId?: string;
  status?: string;
  entryType?: string;
  amount?: string;
  /** Pendências: a quem foi atribuída. */
  assigneeUserId?: string | null;
}

const CONSOLIDATED = ["APPROVED_FOR_LEDGER", "LOCKED_IN_CLOSING"];

const inScope = (s: Scope, r: Resource) =>
  (s.businessUnitId === null || r.businessUnitId === undefined || r.businessUnitId === s.businessUnitId) &&
  (s.financialAccountId === null || r.financialAccountId === undefined || r.financialAccountId === s.financialAccountId);

function employeeAllows(access: Access, permission: Permission, r: Resource): boolean {
  const scopes = access.scopes.filter((s) => inScope(s, r)); // sem escopo => nada
  if (scopes.length === 0) return false;
  const own = r.ownerUserId === access.userId;
  switch (permission) {
    case "tenant.view":
    case "structure.view":
      return true;
    case "documents.upload":
      return scopes.some((s) => s.canUploadDocuments);
    case "entries.create":
      return scopes.some((s) =>
        s.canCreateManualEntries &&
        r.entryType !== undefined && s.allowedEntryTypes.includes(r.entryType) &&
        r.amount !== undefined &&
        (s.maxEntryAmount === null || money(r.amount).lessThanOrEqualTo(money(s.maxEntryAmount))));
    case "entries.view":
      // Sem ownerUserId/status é a consulta da lista; cada linha é conferida depois.
      if (r.ownerUserId === undefined) return true;
      return own && !(access.blindMode && CONSOLIDATED.includes(r.status ?? ""));
    case "entries.edit":
      return own && (r.status === "DRAFT" || r.status === "RETURNED_FOR_CORRECTION");
    case "reports.view":
      return !access.blindMode && scopes.some((s) => s.canViewReports);
    case "balances.view":
      return !access.blindMode && scopes.some((s) => s.canViewBankBalances);
    case "documents.view":
      return r.ownerUserId === undefined || own;
    case "issues.view":
    case "issues.respond":
      // Sem assigneeUserId é a consulta da lista; cada linha é conferida depois.
      return r.assigneeUserId === undefined ? permission === "issues.view" : r.assigneeUserId === access.userId;
    default:
      return false;
  }
}

function roleAllows(access: Access, role: Role, permission: Permission, r: Resource): boolean {
  if (!(PERMISSIONS[permission] as readonly Role[]).includes(role)) return false;
  if (role === "CLIENT_EMPLOYEE") return employeeAllows(access, permission, r);
  if (permission === "entries.edit") {
    if (CONSOLIDATED.includes(r.status ?? "")) return false;
    if (role === "CLIENT_MASTER") {
      return r.ownerUserId === access.userId &&
        ["DRAFT", "SUBMITTED_PENDING_BPO", "RETURNED_FOR_CORRECTION"].includes(r.status ?? "");
    }
  }
  return true;
}

/** Papel que autoriza a ação, ou null. */
export function grantingRole(access: Access, permission: Permission, resource: Resource = {}): Role | null {
  return ROLE_PRIORITY.find((role) => access.roles.includes(role) && roleAllows(access, role, permission, resource)) ?? null;
}

export const can = (access: Access, permission: Permission, resource: Resource = {}) =>
  grantingRole(access, permission, resource) !== null;

export function assertCan(access: Access, permission: Permission, resource: Resource = {}): Role {
  const role = grantingRole(access, permission, resource);
  if (!role) throw forbidden();
  return role;
}
