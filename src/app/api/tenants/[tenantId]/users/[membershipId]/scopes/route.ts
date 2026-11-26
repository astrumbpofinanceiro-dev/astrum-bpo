import { body, route, uuidParam } from "../../../../../../../server/http";
import { replaceScopes } from "../../../../../../../modules/identity-access/user-management";

export const PUT = route(async ({ principal, deps, params, request }) =>
  replaceScopes(deps.pool, principal, params.tenantId!, uuidParam(params.membershipId), await body(request)));
