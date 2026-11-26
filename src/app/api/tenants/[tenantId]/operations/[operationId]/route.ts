import { route, uuidParam } from "../../../../../../server/http";
import { inTenant } from "../../../../../../modules/identity-access/tenant-access";
import { getOperation } from "../../../../../../modules/financial-core/operations";

export const GET = route(async ({ principal, deps, params }) => {
  const id = uuidParam(params.operationId);
  return inTenant(deps.pool, principal, params.tenantId!, { permission: "finance.view" }, (c, a) => getOperation(c, a, id));
});
