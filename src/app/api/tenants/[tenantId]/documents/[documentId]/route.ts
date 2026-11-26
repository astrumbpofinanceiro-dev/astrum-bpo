import { route, uuidParam } from "../../../../../../server/http";
import { listDocuments } from "../../../../../../modules/document-intake/index";
import { inTenant } from "../../../../../../modules/identity-access/tenant-access";
import { forbidden } from "../../../../../../shared/errors";

export const GET = route(async ({ principal, deps, params }) => {
  const id = uuidParam(params.documentId);
  return inTenant(deps.pool, principal, params.tenantId!, { permission: "documents.view" }, async (c, a) => {
    const [document] = await listDocuments(c, a, { id });
    if (!document) throw forbidden();
    return document;
  });
});
