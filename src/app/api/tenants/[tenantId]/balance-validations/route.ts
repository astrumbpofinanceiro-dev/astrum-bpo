import { route } from "../../../../../server/http";
import { inTenant } from "../../../../../modules/identity-access/tenant-access";
import { listAccountsForValidation } from "../../../../../modules/closing-reporting/closing";

export const GET = route(async ({ principal, deps, params }) =>
  inTenant(deps.pool, principal, params.tenantId!, { permission: "finance.view" }, (c, a) => listAccountsForValidation(c, a)));
