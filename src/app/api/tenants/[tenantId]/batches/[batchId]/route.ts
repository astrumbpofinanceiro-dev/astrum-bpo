import { body, route, uuidParam } from "../../../../../../server/http";
import { getBatch, resolveOverlap } from "../../../../../../modules/import-processing/importer";
import { inTenant } from "../../../../../../modules/identity-access/tenant-access";

// Itens do lote expõem o extrato: somente quem opera o processamento.
export const GET = route(async ({ principal, deps, params }) => {
  const id = uuidParam(params.batchId);
  return inTenant(deps.pool, principal, params.tenantId!, { permission: "processing.operate" }, (c, a) => getBatch(c, a, id));
});

/** Decide itens em OVERLAP_REVIEW. */
export const POST = route(async ({ principal, deps, params, request }) => {
  const id = uuidParam(params.batchId);
  const input = await body(request);
  return inTenant(deps.pool, principal, params.tenantId!, { permission: "processing.operate" },
    (c, a) => resolveOverlap(c, a, id, input));
});
