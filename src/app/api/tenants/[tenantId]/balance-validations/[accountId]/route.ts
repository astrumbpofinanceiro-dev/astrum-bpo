import { route, uuidParam } from "../../../../../../server/http";
import { inTenant } from "../../../../../../modules/identity-access/tenant-access";
import { validateBalance } from "../../../../../../modules/closing-reporting/closing";

export const POST = route(async ({ principal, deps, params }) => {
  const id = uuidParam(params.accountId);
  return inTenant(deps.pool, principal, params.tenantId!, { permission: "closing.publish" }, (c, a) => validateBalance(c, a, id));
});
