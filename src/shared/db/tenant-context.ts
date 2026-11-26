import type pg from "pg";
import { z } from "zod";

export const actorRoles = [
  "BPO_MASTER", "BPO_ANALYST", "BPO_REVIEWER", "BPO_AUDITOR",
  "CLIENT_MASTER", "CLIENT_EMPLOYEE", "SYSTEM_WORKER",
  /** Usuário autenticado sem vínculo: só para registrar tentativa negada. */
  "NO_ROLE",
] as const;

const contextSchema = z.object({
  userId: z.guid(),
  /** null somente para operações globais (ex.: listar/criar empresas). */
  tenantId: z.guid().nullable(),
  actorRole: z.enum(actorRoles),
  source: z.enum(["UI", "API", "JOB", "IMPORT"]),
  correlationId: z.guid().optional(),
  changeReason: z.string().trim().min(1).optional(),
  impersonationReason: z.string().trim().min(1).optional(),
});

export type RequestContext = z.infer<typeof contextSchema>;

/**
 * Único caminho de acesso ao banco. O contexto deve vir de sessão já validada
 * no servidor (Etapa 2), nunca de parâmetros enviados pelo navegador.
 * set_config(..., true) equivale a SET LOCAL: vale só nesta transação.
 */
export async function withContext<T>(
  pool: pg.Pool,
  input: RequestContext,
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const ctx = contextSchema.parse(input);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `SELECT set_config('app.current_user_id', $1, true), set_config('app.current_tenant_id', $2, true),
              set_config('app.is_bpo_master', $3, true), set_config('app.actor_role', $4, true),
              set_config('app.source', $5, true), set_config('app.correlation_id', $6, true),
              set_config('app.change_reason', $7, true), set_config('app.impersonation_reason', $8, true)`,
      [ctx.userId, ctx.tenantId ?? "", String(ctx.actorRole === "BPO_MASTER"), ctx.actorRole,
       ctx.source, ctx.correlationId ?? "", ctx.changeReason ?? "", ctx.impersonationReason ?? ""],
    );
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Recusa subir com credencial que ignore RLS. Chamar na inicialização. */
export async function assertUnprivilegedRole(pool: pg.Pool): Promise<void> {
  const { rows } = await pool.query<{ unsafe: boolean }>(
    `SELECT (r.rolsuper OR r.rolbypassrls OR EXISTS (
        SELECT 1 FROM pg_tables t WHERE t.schemaname = 'public' AND pg_has_role(current_user, t.tableowner, 'MEMBER')
      )) AS unsafe FROM pg_roles r WHERE r.rolname = current_user`);
  if (rows[0]?.unsafe !== false) throw new Error("DATABASE_URL usa uma role que pode contornar RLS.");
}

/**
 * Somente identifica o usuário (sem tenant e sem papel). Serve para descobrir os
 * próprios vínculos logo após a autenticação. Não permite escrita auditada.
 */
export async function withIdentity<T>(pool: pg.Pool, userId: string, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const id = z.guid().parse(userId);
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query("SELECT set_config('app.current_user_id', $1, true)", [id]);
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
