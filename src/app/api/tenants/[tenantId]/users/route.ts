import { body, route } from "../../../../../server/http";
import { inTenant } from "../../../../../modules/identity-access/tenant-access";
import { createClientUser, listClientUsers } from "../../../../../modules/identity-access/user-management";

export const GET = route(async ({ principal, deps, params }) =>
  inTenant(deps.pool, principal, params.tenantId!, { permission: "client_users.view" }, (c, a) => listClientUsers(c, a.tenantId)));

export const POST = route(async ({ principal, deps, params, request }) =>
  createClientUser(deps.pool, deps.identity, principal, params.tenantId!, await body(request)));
