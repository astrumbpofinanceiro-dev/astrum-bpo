import { body, route } from "../../../../../server/http";
import { inTenant } from "../../../../../modules/identity-access/tenant-access";
import { forbidden } from "../../../../../shared/errors";
import { createCategory, listCategories } from "../../../../../modules/tenants-config/structure";

export const GET = route(async ({ principal, deps, params }) =>
  inTenant(deps.pool, principal, params.tenantId!, { permission: "structure.view" }, async (c, a) => {
    // Funcionário em Modo Cego não vê a estrutura contábil (ex.: retiradas de sócios).
    if (a.roles.includes("CLIENT_EMPLOYEE")) throw forbidden();
    return listCategories(c, a.tenantId);
  }));

export const POST = route(async ({ principal, deps, params, request }) => {
  const input = await body(request);
  return inTenant(deps.pool, principal, params.tenantId!, { permission: "structure.manage" }, (c, a) =>
    createCategory(c, a.tenantId, input));
});
