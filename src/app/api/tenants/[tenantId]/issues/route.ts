import { body, route } from "../../../../../server/http";
import { listIssues, openIssue } from "../../../../../modules/issues-approvals/issues";
import { inTenant } from "../../../../../modules/identity-access/tenant-access";

export const GET = route(async ({ principal, deps, params }) =>
  inTenant(deps.pool, principal, params.tenantId!, { permission: "issues.view" }, (c, a) => listIssues(c, a)));

export const POST = route(async ({ principal, deps, params, request }) => {
  const input = await body(request);
  return inTenant(deps.pool, principal, params.tenantId!, { permission: "issues.open" }, (c, a) => openIssue(c, a, input));
});
