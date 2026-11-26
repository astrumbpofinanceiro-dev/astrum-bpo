import { route, uuidParam } from "../../../../../../../server/http";
import { downloadUrl } from "../../../../../../../modules/document-intake/index";
import { inTenant } from "../../../../../../../modules/identity-access/tenant-access";

/** URL assinada de curta duração; o arquivo nunca é público. */
export const GET = route(async ({ principal, deps, params }) => {
  const id = uuidParam(params.documentId);
  return inTenant(deps.pool, principal, params.tenantId!, { permission: "documents.view" },
    (c, a) => downloadUrl(c, a, deps.storage, id));
});
