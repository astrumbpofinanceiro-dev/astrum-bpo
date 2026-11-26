import { route, body, query } from "../../../../../server/http";
import { inTenant } from "../../../../../modules/identity-access/tenant-access";
import { closingStatus, publish } from "../../../../../modules/closing-reporting/closing";
import { guarded } from "../../../../../modules/closing-reporting/approvals";

export const GET = route(async ({ principal, deps, params, request }) =>
  inTenant(deps.pool, principal, params.tenantId!, { permission: "finance.view" },
    (c, a) => closingStatus(c, a, query(request, "month") ?? "")));

export const POST = route(async ({ principal, deps, params, request }) => {
  const input = await body(request);
  const caveats = typeof input === "object" && input !== null && "caveats" in input;
  return inTenant(deps.pool, principal, params.tenantId!,
    { permission: caveats ? "closing.publish_with_caveats" : "closing.publish" },
    (c, a) => caveats ? guarded(c, a, "PUBLISH_WITH_CAVEATS", null, input) : publish(c, a, input));
});
