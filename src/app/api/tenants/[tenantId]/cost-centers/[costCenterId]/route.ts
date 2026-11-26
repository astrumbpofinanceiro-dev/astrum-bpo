import { body, route, uuidParam } from "../../../../../../server/http";
import { inTenant } from "../../../../../../modules/identity-access/tenant-access";
import { updateCostCenter } from "../../../../../../modules/tenants-config/structure";

export const PATCH = route(async ({ principal, deps, params, request }) => {
  const id = uuidParam(params.costCenterId);
  const input = await body(request);
  return inTenant(deps.pool, principal, params.tenantId!, { permission: "structure.manage" }, (c, a) =>
    updateCostCenter(c, a.tenantId, id, input));
});
