import { body, query, route } from "../../../../../server/http";
import { inTenant } from "../../../../../modules/identity-access/tenant-access";
import { createSettingVersion, settingInput } from "../../../../../modules/tenants-config/settings";

/** Histórico completo de versões (opcionalmente de uma chave). */
export const GET = route(async ({ principal, deps, params, request }) =>
  inTenant(deps.pool, principal, params.tenantId!, { permission: "settings.view" }, async (c, a) =>
    (await c.query(
      `SELECT id, setting_key, setting_value, effective_from, effective_to, version, updated_by_user_id, created_at
         FROM client_settings WHERE tenant_id = $1 AND ($2::text IS NULL OR setting_key = $2)
        ORDER BY setting_key, version DESC`, [a.tenantId, query(request, "key") ?? null])).rows));

export const POST = route(async ({ principal, deps, params, request }) => {
  const input = settingInput.parse(await body(request));
  return inTenant(deps.pool, principal, params.tenantId!, { permission: "settings.manage" }, (c, a) =>
    createSettingVersion(c, a.tenantId, a.userId, input));
});
