import { route } from "../../../../../server/http";
import { inTenant } from "../../../../../modules/identity-access/tenant-access";
import { listOpenInstallments } from "../../../../../modules/financial-core/operations";

export const GET = route(async ({ principal, deps, params }) => {
  return inTenant(deps.pool, principal, params.tenantId!, { permission: "finance.view" }, (c, a) => listOpenInstallments(c, a));
});
