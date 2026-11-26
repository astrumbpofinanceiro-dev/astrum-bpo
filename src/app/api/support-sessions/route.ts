import { z } from "zod";
import { body, route } from "../../../server/http";
import { endSupportSession, startSupportSession } from "../../../modules/identity-access/support-session";

const start = z.strictObject({ tenantId: z.guid(), reason: z.string().max(500) });
const end = z.strictObject({ tenantId: z.guid() });

export const POST = route(async ({ principal, deps, request }) => {
  const input = start.parse(await body(request));
  const s = await startSupportSession(deps.pool, principal, input.tenantId, input.reason);
  return { id: s.id, expiresAt: s.expiresAt };
});

export const DELETE = route(async ({ principal, deps, request }) => {
  const input = end.parse(await body(request));
  await endSupportSession(deps.pool, principal, input.tenantId);
});
