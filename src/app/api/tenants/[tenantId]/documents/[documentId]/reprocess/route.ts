import { route, uuidParam } from "../../../../../../../server/http";
import { reprocessDocument } from "../../../../../../../modules/document-intake/index";
import { inTenant } from "../../../../../../../modules/identity-access/tenant-access";

export const POST = route(async ({ principal, deps, params }) => {
  const id = uuidParam(params.documentId);
  return inTenant(deps.pool, principal, params.tenantId!, { permission: "processing.operate" },
    (c, a) => reprocessDocument(c, a, id));
});
