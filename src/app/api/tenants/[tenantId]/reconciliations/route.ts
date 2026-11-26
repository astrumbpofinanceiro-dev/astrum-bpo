import { body, route } from "../../../../../server/http";
import { inTenant } from "../../../../../modules/identity-access/tenant-access";
import { reconcile } from "../../../../../modules/reconciliation/reconciliation";

export const POST = route(async ({ principal, deps, params, request }) => {
  const input = await body(request);
  return inTenant(deps.pool, principal, params.tenantId!, { permission: "processing.operate" }, (c, a) => reconcile(c, a, input));
});
