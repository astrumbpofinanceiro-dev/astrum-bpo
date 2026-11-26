import { body, route, uuidParam } from "../../../../../../../server/http";
import { respondIssue } from "../../../../../../../modules/issues-approvals/issues";
import { inTenant } from "../../../../../../../modules/identity-access/tenant-access";

export const POST = route(async ({ principal, deps, params, request }) => {
  const id = uuidParam(params.issueId);
  const input = await body(request);
  // A atribuição é conferida em respondIssue, depois de carregar a pendência.
  return inTenant(deps.pool, principal, params.tenantId!, { permission: "issues.view" },
    (c, a) => respondIssue(c, a, id, input));
});
