import { route } from "../../../../../server/http";
import { inTenant } from "../../../../../modules/identity-access/tenant-access";
import { listApprovals } from "../../../../../modules/closing-reporting/approvals";

export const GET = route(async ({ principal, deps, params }) =>
  inTenant(deps.pool, principal, params.tenantId!, { permission: "finance.view" }, (c, a) => listApprovals(c, a)));
