import { body, route } from "../../../../../../server/http";
import { inTenant } from "../../../../../../modules/identity-access/tenant-access";
import { approveOperations } from "../../../../../../modules/financial-core/operations";

export const POST = route(async ({ principal, deps, params, request }) => {
  const input = await body(request);
  return inTenant(deps.pool, principal, params.tenantId!, { permission: "entries.approve" }, (c, a) => approveOperations(c, a, input));
});
