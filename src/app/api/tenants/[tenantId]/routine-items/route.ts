import { route, query } from "../../../../../server/http";
import { inTenant } from "../../../../../modules/identity-access/tenant-access";
import { listItems } from "../../../../../modules/client-routine/routines";
import { month } from "../../../../../modules/closing-reporting/closing";

export const GET = route(async ({ principal, deps, params, request }) => {
  const m = month.parse(query(request, "month"));
  return inTenant(deps.pool, principal, params.tenantId!, { permission: "tenant.view" }, (c, a) => listItems(c, a, m));
});
