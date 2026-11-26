import { body, route } from "../../../../../server/http";
import { inTenant } from "../../../../../modules/identity-access/tenant-access";
import { assignStaff, listStaff } from "../../../../../modules/identity-access/user-management";

export const GET = route(async ({ principal, deps, params }) =>
  inTenant(deps.pool, principal, params.tenantId!, { permission: "staff.manage" }, (c, a) => listStaff(c, a.tenantId)));

export const POST = route(async ({ principal, deps, params, request }) =>
  assignStaff(deps.pool, principal, params.tenantId!, await body(request)));
