import { body, route, uuidParam } from "../../../../../../../server/http";
import { inTenant } from "../../../../../../../modules/identity-access/tenant-access";
import { reverseReconciliation } from "../../../../../../../modules/reconciliation/reconciliation";

export const POST = route(async ({ principal, deps, params, request }) => {
  const id = uuidParam(params.groupId);
  const input = await body(request);
  return inTenant(deps.pool, principal, params.tenantId!, { permission: "processing.operate" }, (c, a) => reverseReconciliation(c, a, id, input));
});
