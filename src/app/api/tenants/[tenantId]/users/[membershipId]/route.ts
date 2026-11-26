import { body, route, uuidParam } from "../../../../../../server/http";
import { updateMembership } from "../../../../../../modules/identity-access/user-management";

export const PATCH = route(async ({ principal, deps, params, request }) =>
  updateMembership(deps.pool, principal, params.tenantId!, uuidParam(params.membershipId), await body(request)));
