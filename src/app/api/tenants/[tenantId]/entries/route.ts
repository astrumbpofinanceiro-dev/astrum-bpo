import { body, query, route, uuidParam } from "../../../../../server/http";
import { listEntries } from "../../../../../modules/financial-core/entry-queries";
import { createEntry } from "../../../../../modules/financial-core/manual-entries";
import { inTenant } from "../../../../../modules/identity-access/tenant-access";

export const GET = route(async ({ principal, deps, params, request }) => {
  const unit = query(request, "businessUnitId");
  const businessUnitId = unit === undefined ? undefined : uuidParam(unit);
  // Pedir unidade fora do escopo é 403, não lista vazia.
  return inTenant(deps.pool, principal, params.tenantId!, { permission: "entries.view", resource: { businessUnitId } },
    (c, a) => listEntries(c, a, { businessUnitId }));
});

export const POST = route(async ({ principal, deps, params, request }) => {
  const input = await body(request);
  // Tipo, valor e unidade são conferidos contra o escopo dentro de createEntry.
  return inTenant(deps.pool, principal, params.tenantId!, { permission: "tenant.view" },
    (c, a) => createEntry(c, a, input));
});
