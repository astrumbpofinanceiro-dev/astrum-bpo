import { route, body } from "../../../../../../server/http";
import { inTenant } from "../../../../../../modules/identity-access/tenant-access";
import { guarded } from "../../../../../../modules/closing-reporting/approvals";

export const POST = route(async ({ principal, deps, params, request }) => {
  const input = await body(request);
  return inTenant(deps.pool, principal, params.tenantId!, { permission: "closing.reopen" }, (c, a) => guarded(c, a, "REOPEN", null, input));
});
