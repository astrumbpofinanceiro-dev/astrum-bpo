import { body, route, uuidParam } from "../../../../../../../server/http";
import { inTenant } from "../../../../../../../modules/identity-access/tenant-access";
import { rejectOperation } from "../../../../../../../modules/financial-core/operations";

export const POST = route(async ({ principal, deps, params, request }) => {
  const id = uuidParam(params.operationId);
  const input = await body(request);
  return inTenant(deps.pool, principal, params.tenantId!, { permission: "entries.approve" }, (c, a) => rejectOperation(c, a, id, input));
});
