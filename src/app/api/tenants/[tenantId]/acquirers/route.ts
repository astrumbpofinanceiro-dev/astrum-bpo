import { body, route } from "../../../../../server/http";
import { inTenant } from "../../../../../modules/identity-access/tenant-access";
import { createAcquirer, listAcquirers } from "../../../../../modules/tenants-config/structure";
import { forbidden } from "../../../../../shared/errors";

export const GET = route(async ({ principal, deps, params }) =>
  inTenant(deps.pool, principal, params.tenantId!, { permission: "structure.view" }, async (c, a) => {
    if (a.roles.includes("CLIENT_EMPLOYEE")) throw forbidden(); // expõe a conta de liquidação
    return listAcquirers(c, a.tenantId);
  }));

export const POST = route(async ({ principal, deps, params, request }) => {
  const input = await body(request);
  return inTenant(deps.pool, principal, params.tenantId!, { permission: "structure.manage" }, (c, a) =>
    createAcquirer(c, a.tenantId, input));
});
