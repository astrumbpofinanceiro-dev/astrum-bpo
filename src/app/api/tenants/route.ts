import { randomUUID } from "node:crypto";
import { body, route } from "../../../server/http";
import { tenantInput } from "../../../modules/tenants-config/structure";
import { withContext } from "../../../shared/db/tenant-context";
import { forbidden } from "../../../shared/errors";

/** Empresas visíveis ao usuário (a política de RLS limita a lista). */
export const GET = route(async ({ principal, deps }) =>
  withContext(deps.pool, {
    userId: principal.userId, tenantId: null, source: "API",
    actorRole: principal.isBpoMaster ? "BPO_MASTER" : "NO_ROLE",
  }, async (c) => (await c.query("SELECT id, legal_name, trade_name, segment_code, status FROM tenants ORDER BY trade_name")).rows));

export const POST = route(async ({ principal, deps, request }) => {
  if (!principal.isBpoMaster) throw forbidden();
  const input = tenantInput.parse(await body(request));
  const id = randomUUID();
  await withContext(deps.pool, { userId: principal.userId, tenantId: null, actorRole: "BPO_MASTER", source: "API" }, (c) =>
    c.query("INSERT INTO tenants (id, legal_name, trade_name, tax_id, segment_code) VALUES ($1,$2,$3,$4,$5)",
      [id, input.legalName, input.tradeName, input.taxId, input.segmentCode]));
  return { id };
});
