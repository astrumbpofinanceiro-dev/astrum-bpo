import { route, body, uuidParam } from "../../../../../../server/http";
import { inTenant } from "../../../../../../modules/identity-access/tenant-access";
import { updateItem } from "../../../../../../modules/client-routine/routines";

export const POST = route(async ({ principal, deps, params, request }) => {
  const id = uuidParam(params.itemId);
  const input = await body(request);
  return inTenant(deps.pool, principal, params.tenantId!, { permission: "tenant.view" }, (c, a) => updateItem(c, a, id, input));
});
