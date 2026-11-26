import { route } from "../../../../../../server/http";
import { inTenant } from "../../../../../../modules/identity-access/tenant-access";
import { suggestMatches } from "../../../../../../modules/reconciliation/reconciliation";

export const POST = route(async ({ principal, deps, params }) => {
  return inTenant(deps.pool, principal, params.tenantId!, { permission: "processing.operate" }, (c, a) => suggestMatches(c, a));
});
