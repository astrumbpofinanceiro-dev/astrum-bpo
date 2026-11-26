import { body, route } from "../../../../../server/http";
import { inTenant } from "../../../../../modules/identity-access/tenant-access";
import { createTag, listTags } from "../../../../../modules/tenants-config/structure";
import { forbidden } from "../../../../../shared/errors";

export const GET = route(async ({ principal, deps, params }) =>
  inTenant(deps.pool, principal, params.tenantId!, { permission: "structure.view" }, async (c, a) => {
    // Etiqueta de contrato revela clientes e valores do negócio: fora do Modo Cego.
    if (a.roles.includes("CLIENT_EMPLOYEE")) throw forbidden();
    return listTags(c, a.tenantId);
  }));

export const POST = route(async ({ principal, deps, params, request }) => {
  const input = await body(request);
  return inTenant(deps.pool, principal, params.tenantId!, { permission: "structure.manage" }, (c, a) =>
    createTag(c, a.tenantId, input));
});
