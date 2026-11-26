import { route, uuidParam } from "../../../../../../server/http";
import { can } from "../../../../../../modules/identity-access/authorize";
import { inTenant } from "../../../../../../modules/identity-access/tenant-access";
import { getVersion } from "../../../../../../modules/closing-reporting/closing";
import { forbidden } from "../../../../../../shared/errors";

export const GET = route(async ({ principal, deps, params }) => {
  const id = uuidParam(params.versionId);
  return inTenant(deps.pool, principal, params.tenantId!, { permission: "reports.view", resource: { businessUnitId: null, financialAccountId: null } }, async (c, a) => {
    const version = await getVersion(c, a.tenantId, id);
    if (!version || (version.status !== "ACTIVE" && a.roles.some((r) => r.startsWith("CLIENT_")))) throw forbidden();
    // Saldos exigem permissão própria.
    if (!can(a, "balances.view", { businessUnitId: null, financialAccountId: null })) {
      const { inflows, outflows, netCashFlow } = version.snapshot.cash;
      version.snapshot.cash = { inflows, outflows, netCashFlow };
    }
    return version;
  });
});
