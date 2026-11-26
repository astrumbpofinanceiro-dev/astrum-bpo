import { route, body, uuidParam } from "../../../../../../server/http";
import { inTenant } from "../../../../../../modules/identity-access/tenant-access";
import { decide } from "../../../../../../modules/closing-reporting/approvals";

export const POST = route(async ({ principal, deps, params, request }) => {
  const id = uuidParam(params.approvalId);
  const input = await body(request);
  return inTenant(deps.pool, principal, params.tenantId!, { permission: "approvals.decide" }, (c, a) => decide(c, a, id, input));
});
