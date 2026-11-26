import { body, route } from "../../../../server/http";
import { inTenant } from "../../../../modules/identity-access/tenant-access";
import { tenantPatch } from "../../../../modules/tenants-config/structure";

export const GET = route(async ({ principal, deps, params }) =>
  inTenant(deps.pool, principal, params.tenantId!, { permission: "tenant.view" }, async (c, a) =>
    (await c.query("SELECT id, legal_name, trade_name, segment_code, status FROM tenants WHERE id = $1", [a.tenantId])).rows[0]));

export const PATCH = route(async ({ principal, deps, params, request }) => {
  const patch = tenantPatch.parse(await body(request));
  await inTenant(deps.pool, principal, params.tenantId!, { permission: "tenant.manage" }, async (c, a) => {
    await c.query(
      "UPDATE tenants SET legal_name = COALESCE($2, legal_name), trade_name = COALESCE($3, trade_name), status = COALESCE($4, status) WHERE id = $1",
      [a.tenantId, patch.legalName ?? null, patch.tradeName ?? null, patch.status ?? null]);
  });
});
