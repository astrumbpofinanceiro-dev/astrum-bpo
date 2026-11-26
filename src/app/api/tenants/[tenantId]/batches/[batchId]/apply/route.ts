import { route, uuidParam } from "../../../../../../../server/http";
import { inTenant } from "../../../../../../../modules/identity-access/tenant-access";
import { applyAcquirerBatch } from "../../../../../../../modules/receivables/acquirer-batch";

export const POST = route(async ({ principal, deps, params }) => {
  const id = uuidParam(params.batchId);
  return inTenant(deps.pool, principal, params.tenantId!, { permission: "processing.operate" }, (c, a) => applyAcquirerBatch(c, a, id));
});
