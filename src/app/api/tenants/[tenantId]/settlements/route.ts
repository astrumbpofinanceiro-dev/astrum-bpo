import { body, route } from "../../../../../server/http";
import { inTenant } from "../../../../../modules/identity-access/tenant-access";
import { createSettlement } from "../../../../../modules/receivables/cards";

export const POST = route(async ({ principal, deps, params, request }) => {
  const input = await body(request);
  return inTenant(deps.pool, principal, params.tenantId!, { permission: "processing.operate" }, (c, a) => createSettlement(c, a, input));
});
