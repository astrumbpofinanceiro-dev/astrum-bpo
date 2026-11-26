import { route, uuidParam } from "../../../../../../server/http";
import { revokeStaff } from "../../../../../../modules/identity-access/user-management";

export const DELETE = route(async ({ principal, deps, params }) =>
  revokeStaff(deps.pool, principal, params.tenantId!, uuidParam(params.assignmentId)));
