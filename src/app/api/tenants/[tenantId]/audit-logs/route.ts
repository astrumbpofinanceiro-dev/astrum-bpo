import { query, route } from "../../../../../server/http";
import { listAuditLogs } from "../../../../../modules/audit/index";
import { inTenant } from "../../../../../modules/identity-access/tenant-access";

export const GET = route(async ({ principal, deps, params, request }) =>
  inTenant(deps.pool, principal, params.tenantId!, { permission: "audit.view" }, (c, a) =>
    listAuditLogs(c, a.tenantId, Number(query(request, "limit") ?? 100) || 100)));
