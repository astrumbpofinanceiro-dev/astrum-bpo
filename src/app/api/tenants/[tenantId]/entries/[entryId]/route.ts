import { body, route, uuidParam } from "../../../../../../server/http";
import { listEntries } from "../../../../../../modules/financial-core/entry-queries";
import { deleteEntry, updateEntry } from "../../../../../../modules/financial-core/manual-entries";
import { inTenant } from "../../../../../../modules/identity-access/tenant-access";
import { forbidden } from "../../../../../../shared/errors";

export const GET = route(async ({ principal, deps, params }) => {
  const id = uuidParam(params.entryId);
  return inTenant(deps.pool, principal, params.tenantId!, { permission: "entries.view" }, async (c, a) => {
    const [entry] = await listEntries(c, a, { id });
    if (!entry) throw forbidden(); // inexistente e não permitido respondem igual
    return entry;
  });
});

export const PATCH = route(async ({ principal, deps, params, request }) => {
  const id = uuidParam(params.entryId);
  const input = await body(request);
  return inTenant(deps.pool, principal, params.tenantId!, { permission: "tenant.view" }, (c, a) => updateEntry(c, a, id, input));
});

export const DELETE = route(async ({ principal, deps, params }) => {
  const id = uuidParam(params.entryId);
  await inTenant(deps.pool, principal, params.tenantId!, { permission: "tenant.view" }, (c, a) => deleteEntry(c, a, id));
});
