import { body, route } from "../../../../../server/http";
import { inTenant } from "../../../../../modules/identity-access/tenant-access";
import { createAccount, listAccounts } from "../../../../../modules/tenants-config/structure";

export const GET = route(async ({ principal, deps, params }) =>
  inTenant(deps.pool, principal, params.tenantId!, { permission: "structure.view" }, listAccounts));

export const POST = route(async ({ principal, deps, params, request }) => {
  const input = await body(request);
  return inTenant(deps.pool, principal, params.tenantId!, { permission: "structure.manage" }, (c, a) =>
    createAccount(c, a.tenantId, input));
});
