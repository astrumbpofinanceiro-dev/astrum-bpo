import { z } from "zod";
import { body, route, uuidParam } from "../../../../server/http";
import { setUserActive } from "../../../../modules/identity-access/user-management";

const patch = z.strictObject({ isActive: z.boolean() });

export const PATCH = route(async ({ principal, deps, params, request }) => {
  const { isActive } = patch.parse(await body(request));
  await setUserActive(deps.pool, principal, uuidParam(params.userId), isActive);
});
