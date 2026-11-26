import { route } from "../../../../../server/http";
import { inTenant } from "../../../../../modules/identity-access/tenant-access";
import { listBalances } from "../../../../../modules/tenants-config/structure";

export const GET = route(async ({ principal, deps, params }) =>
  inTenant(deps.pool, principal, params.tenantId!, { permission: "balances.view" }, listBalances));
