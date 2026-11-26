/**
 * Acesso do BPO Master a um cliente (v3.1 §3.1): motivo, início, fim e ações.
 * Início e fim são eventos em audit_logs; as ações levam o motivo pelo gatilho.
 */
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { withContext } from "../../shared/db/tenant-context";
import { forbidden, invalid } from "../../shared/errors";
import { insertEvent } from "../audit/index";
import type { Principal } from "./principal";

export const SUPPORT_SESSION_MINUTES = 60;

export interface SupportSession { id: string; reason: string; expiresAt: Date }

const masterContext = (userId: string, tenantId: string, reason: string) =>
  ({ userId, tenantId, actorRole: "BPO_MASTER", source: "API", impersonationReason: reason }) as const;

export async function findSupportSession(pool: pg.Pool, userId: string, tenantId: string): Promise<SupportSession | null> {
  const row = await withContext(pool, { userId, tenantId, actorRole: "BPO_MASTER", source: "API" }, async (c) =>
    (await c.query(
      `SELECT s.entity_id AS id, s.reason, s.created_at + make_interval(mins => $3) AS expires_at
         FROM audit_logs s
        WHERE s.tenant_id = $1 AND s.actor_user_id = $2 AND s.entity_type = 'support_session'
          AND s.action = 'SUPPORT_ACCESS_START' AND s.created_at > now() - make_interval(mins => $3)
          AND NOT EXISTS (SELECT 1 FROM audit_logs e WHERE e.tenant_id = s.tenant_id
                AND e.entity_type = 'support_session' AND e.entity_id = s.entity_id AND e.action = 'SUPPORT_ACCESS_END')
        ORDER BY s.created_at DESC LIMIT 1`,
      [tenantId, userId, SUPPORT_SESSION_MINUTES])).rows[0]);
  return row ? { id: row.id, reason: row.reason, expiresAt: row.expires_at } : null;
}

export async function endSupportSession(pool: pg.Pool, principal: Principal, tenantId: string): Promise<void> {
  if (!principal.isBpoMaster) throw forbidden();
  // Encerra todas as sessões abertas, inclusive as abertas em paralelo.
  for (let s = await findSupportSession(pool, principal.userId, tenantId); s;
       s = await findSupportSession(pool, principal.userId, tenantId)) {
    const current = s;
    await withContext(pool, masterContext(principal.userId, tenantId, current.reason), (c) =>
      insertEvent(c, { tenantId, entityType: "support_session", entityId: current.id, action: "SUPPORT_ACCESS_END" }));
  }
}

export async function startSupportSession(
  pool: pg.Pool, principal: Principal, tenantId: string, reason: string,
): Promise<SupportSession> {
  if (!principal.isBpoMaster) throw forbidden();
  const why = reason.trim();
  if (why.length < 10) throw invalid("SUPPORT_REASON_TOO_SHORT");
  const exists = await withContext(pool, { userId: principal.userId, tenantId, actorRole: "BPO_MASTER", source: "API" },
    async (c) => (await c.query("SELECT 1 FROM tenants WHERE id = $1", [tenantId])).rowCount);
  if (!exists) throw forbidden();
  await endSupportSession(pool, principal, tenantId);
  const id = randomUUID();
  await withContext(pool, masterContext(principal.userId, tenantId, why), (c) =>
    insertEvent(c, { tenantId, entityType: "support_session", entityId: id, action: "SUPPORT_ACCESS_START", reason: why }));
  return (await findSupportSession(pool, principal.userId, tenantId))!;
}
