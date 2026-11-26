import { route, query } from "../../../../../server/http";
import { inTenant } from "../../../../../modules/identity-access/tenant-access";
import { fullReport } from "../../../../../modules/closing-reporting/reports";

export const GET = route(async ({ principal, deps, params, request }) =>
  inTenant(deps.pool, principal, params.tenantId!, { permission: "finance.view" },
    (c, a) => fullReport(c, a.tenantId, query(request, "month") ?? "")));
