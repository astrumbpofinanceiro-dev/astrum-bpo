import { body, route, uuidParam } from "../../../../../../../server/http";
import { reviewDocument } from "../../../../../../../modules/document-intake/index";
import { inTenant } from "../../../../../../../modules/identity-access/tenant-access";

export const POST = route(async ({ principal, deps, params, request }) => {
  const id = uuidParam(params.documentId);
  const input = await body(request);
  return inTenant(deps.pool, principal, params.tenantId!, { permission: "processing.operate" },
    (c, a) => reviewDocument(c, a, id, input));
});
