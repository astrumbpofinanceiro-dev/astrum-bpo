import { route, body, query } from "../../../../../server/http";
import { inTenant } from "../../../../../modules/identity-access/tenant-access";
import { createRoutine, generateItems } from "../../../../../modules/client-routine/routines";
import { month } from "../../../../../modules/closing-reporting/closing";

export const POST = route(async ({ principal, deps, params, request }) => {
  const input = await body(request);
  return inTenant(deps.pool, principal, params.tenantId!, { permission: "structure.manage" }, (c, a) => createRoutine(c, a, input));
});

/** Gera os itens do mês (idempotente). */
export const PUT = route(async ({ principal, deps, params, request }) => {
  const m = month.parse(query(request, "month"));
  return inTenant(deps.pool, principal, params.tenantId!, { permission: "processing.operate" }, (c, a) => generateItems(c, a, m));
});
