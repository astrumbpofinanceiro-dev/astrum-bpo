import { route, body, uuidParam } from "../../../../../../../server/http";
import { inTenant } from "../../../../../../../modules/identity-access/tenant-access";
import { reopenIssue } from "../../../../../../../modules/issues-approvals/issues";

export const POST = route(async ({ principal, deps, params, request }) => {
  const id = uuidParam(params.issueId);
  const input = await body(request);
  return inTenant(deps.pool, principal, params.tenantId!, { permission: "issues.validate" }, (c, a) => reopenIssue(c, a, id, input));
});
