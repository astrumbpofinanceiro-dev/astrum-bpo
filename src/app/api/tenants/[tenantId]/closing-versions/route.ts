import { route } from "../../../../../server/http";
import { inTenant } from "../../../../../modules/identity-access/tenant-access";
import { listVersions } from "../../../../../modules/closing-reporting/closing";

// Relatórios consolidados: funcionário com escopo restrito a uma unidade não acessa.
export const GET = route(async ({ principal, deps, params }) =>
  inTenant(deps.pool, principal, params.tenantId!, { permission: "reports.view", resource: { businessUnitId: null, financialAccountId: null } },
    async (c, a) => (await listVersions(c, a.tenantId)).filter((v) => v.status === "ACTIVE" || !a.roles.some((r) => r.startsWith("CLIENT_")))));
