/** Matriz do Documento 1 §3. Alterações exigem aprovação do responsável pelo produto. */
export type BpoRole = "BPO_ANALYST" | "BPO_REVIEWER" | "BPO_AUDITOR";
export type ClientRole = "CLIENT_MASTER" | "CLIENT_EMPLOYEE";
export type Role = "BPO_MASTER" | BpoRole | ClientRole;

const M = "BPO_MASTER", AN = "BPO_ANALYST", RV = "BPO_REVIEWER", AU = "BPO_AUDITOR",
  CM = "CLIENT_MASTER", EM = "CLIENT_EMPLOYEE";

export const PERMISSIONS = {
  "tenant.view": [M, AN, RV, AU, CM, EM],
  "tenant.manage": [M],
  "staff.manage": [M],
  "client_users.view": [M, AU, CM],
  "client_users.manage": [M, CM],
  "structure.view": [M, AN, RV, AU, CM, EM],
  "structure.manage": [M],
  "settings.view": [M, AN, RV, AU, CM],
  "settings.manage": [M],
  "documents.upload": [M, AN, RV, CM, EM],
  "documents.view": [M, AN, RV, AU, CM, EM],
  "issues.view": [M, AN, RV, AU, CM, EM],
  "processing.operate": [M, AN, RV],
  "issues.open": [M, AN, RV],
  "issues.respond": [M, AN, RV, CM, EM],
  "issues.validate": [M, RV],
  "approvals.decide": [M, RV],
  "finance.view": [M, AN, RV, AU],
  "entries.view": [M, AN, RV, AU, CM, EM],
  "entries.create": [M, AN, RV, CM, EM],
  "entries.edit": [M, AN, RV, CM, EM],
  "entries.approve": [M, RV],
  "adjustments.create": [M, RV],
  "closing.prepare": [M, AN, RV],
  "closing.publish": [M, RV],
  "closing.publish_with_caveats": [M, RV],
  "closing.reopen": [M, RV],
  "reports.view": [M, AN, RV, AU, CM, EM],
  "balances.view": [M, AN, RV, AU, CM, EM],
  "audit.view": [M, AU],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

/** Ordem usada para registrar na auditoria o papel que autorizou a ação. */
export const ROLE_PRIORITY: readonly Role[] = [M, RV, AN, AU, CM, EM];
