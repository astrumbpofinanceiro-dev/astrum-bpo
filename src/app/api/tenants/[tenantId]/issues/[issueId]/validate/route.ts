import { body, route, uuidParam } from "../../../../../../../server/http";
import { validateIssue } from "../../../../../../../modules/issues-approvals/issues";
import { inTenant } from "../../../../../../../modules/identity-access/tenant-access";

export const POST = route(async ({ principal, deps, params, request }) => {
  const id = uuidParam(params.issueId);
  const input = await body(request);
  return inTenant(deps.pool, principal, params.tenantId!, { permission: "issues.validate" },
    (c, a) => validateIssue(c, a, id, input));
});
