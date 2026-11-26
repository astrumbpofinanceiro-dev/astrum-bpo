/**
 * Trilha de auditoria. Alterações de dados são gravadas por gatilho; aqui ficam
 * os eventos de acesso e a consulta.
 */
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { withContext, type RequestContext } from "../../shared/db/tenant-context";

export async function insertEvent(client: pg.PoolClient, event: {
  tenantId: string | null; entityType: string; entityId: string; action: string;
  reason?: string; newValues?: unknown;
}): Promise<void> {
  await client.query(
    `INSERT INTO audit_logs (tenant_id, actor_user_id, actor_effective_role, entity_type, entity_id, action, reason, new_values)
     VALUES ($1, app.current_user_id(), app.setting('app.actor_role'), $2, $3, $4, $5, $6)`,
    [event.tenantId, event.entityType, event.entityId, event.action, event.reason ?? null,
     event.newValues === undefined ? null : JSON.stringify(event.newValues)]);
}

/**
 * Transação própria: o registro permanece mesmo que a requisição falhe.
 * tenant_id fica nulo para não gravar dentro do tenant que foi negado.
 */
export async function logDeniedAccess(
  pool: pg.Pool, userId: string, actorRole: RequestContext["actorRole"], requested: string,
): Promise<void> {
  await withContext(pool, { userId, tenantId: null, actorRole, source: "API" }, (c) =>
    insertEvent(c, {
      tenantId: null, entityType: "access", action: "ACCESS_DENIED",
      entityId: /^[0-9a-f-]{36}$/i.test(requested) ? requested : randomUUID(),
      newValues: { requested: requested.slice(0, 200) },
    }));
}

export async function listAuditLogs(client: pg.PoolClient, tenantId: string, limit = 100) {
  return (await client.query(
    `SELECT id, actor_user_id, actor_effective_role, is_bpo_master_impersonation, impersonation_reason,
            entity_type, entity_id, action, old_values, new_values, reason, source, created_at
       FROM audit_logs WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [tenantId, Math.min(Math.max(limit, 1), 500)])).rows;
}
