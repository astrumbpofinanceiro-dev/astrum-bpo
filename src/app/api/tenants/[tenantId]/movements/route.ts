import { route } from "../../../../../server/http";
import { inTenant } from "../../../../../modules/identity-access/tenant-access";
import { listMovements } from "../../../../../modules/reconciliation/reconciliation";

export const GET = route(async ({ principal, deps, params }) => {
  return inTenant(deps.pool, principal, params.tenantId!, { permission: "finance.view" }, (c, a) => listMovements(c, a));
});
