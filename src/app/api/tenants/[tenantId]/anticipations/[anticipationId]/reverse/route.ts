import { route, body, uuidParam } from "../../../../../../../server/http";
import { inTenant } from "../../../../../../../modules/identity-access/tenant-access";
import { guarded } from "../../../../../../../modules/closing-reporting/approvals";

export const POST = route(async ({ principal, deps, params, request }) => {
  const id = uuidParam(params.anticipationId);
  const input = await body(request);
  return inTenant(deps.pool, principal, params.tenantId!, { permission: "adjustments.create" }, (c, a) => guarded(c, a, "REVERSE_ANTICIPATION", id, input));
});
