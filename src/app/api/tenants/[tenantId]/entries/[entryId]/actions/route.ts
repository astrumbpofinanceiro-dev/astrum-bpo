import { z } from "zod";
import { body, route, uuidParam } from "../../../../../../../server/http";
import { REVIEW_ACTIONS, reviewEntry, submitEntry } from "../../../../../../../modules/financial-core/manual-entries";
import { inTenant } from "../../../../../../../modules/identity-access/tenant-access";

const schema = z.strictObject({
  action: z.enum(["SUBMIT", "START", "APPROVE", "RETURN", "REJECT"]),
  note: z.string().trim().min(3).max(1000).optional(),
});

export const POST = route(async ({ principal, deps, params, request }) => {
  const id = uuidParam(params.entryId);
  const { action, note } = schema.parse(await body(request));
  if (action === "SUBMIT") {
    return inTenant(deps.pool, principal, params.tenantId!, { permission: "tenant.view" }, (c, a) => submitEntry(c, a, id));
  }
  return inTenant(deps.pool, principal, params.tenantId!,
    { permission: REVIEW_ACTIONS[action].permission, changeReason: note },
    (c, a) => reviewEntry(c, a, id, action, note));
});
