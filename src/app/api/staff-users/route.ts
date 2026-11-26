import { body, route } from "../../../server/http";
import { createStaffUser } from "../../../modules/identity-access/user-management";

export const POST = route(async ({ principal, deps, request }) =>
  createStaffUser(deps.pool, deps.identity, principal, await body(request)));
