/** Worker idempotente: consome app.processing_queue com tentativas limitadas (Doc 1, Exceção 5). */
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { withContext } from "../../shared/db/tenant-context";
import type { FileStorage } from "../document-intake/storage";
import { importBatch } from "./importer";
import { ParseError } from "./parsers";

export const SYSTEM_USER_ID = "00000000-0000-4000-8000-000000000001";
export const MAX_ATTEMPTS = 3;

const context = (tenantId: string) => ({
  userId: SYSTEM_USER_ID, tenantId, actorRole: "SYSTEM_WORKER" as const, source: "JOB" as const, correlationId: randomUUID(),
});

const finish = (c: pg.PoolClient, documentId: string) =>
  c.query("DELETE FROM app.processing_queue WHERE document_id = $1", [documentId]);

/** Processa no máximo um documento. Devolve false quando a fila está vazia. */
export async function processNext(pool: pg.Pool, storage: FileStorage): Promise<boolean> {
  // Reserva por 5 minutos; se o processo morrer, o item volta sozinho.
  const job = (await pool.query(
    `UPDATE app.processing_queue SET attempts = attempts + 1, next_attempt_at = now() + interval '5 minutes'
      WHERE document_id = (SELECT document_id FROM app.processing_queue WHERE next_attempt_at <= now()
                            ORDER BY next_attempt_at FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING document_id, tenant_id, attempts`)).rows[0];
  if (!job) return false;
  const { document_id: documentId, tenant_id: tenantId, attempts } = job;

  try {
    await withContext(pool, context(tenantId), async (c) => {
      const document = (await c.query(
        `SELECT d.uploaded_by_user_id, d.processing_status, f.storage_key, f.original_filename, f.sha256_hash
           FROM documents d JOIN document_files f ON f.document_id = d.id AND f.file_role = 'ORIGINAL'
          WHERE d.tenant_id = $1 AND d.id = $2 FOR NO KEY UPDATE OF d`, [tenantId, documentId])).rows[0];
      const batch = (await c.query("SELECT * FROM import_batches WHERE tenant_id = $1 AND document_id = $2",
        [tenantId, documentId])).rows[0];
      if (!document || !batch || document.processing_status !== "QUEUED") return finish(c, documentId);

      await c.query("UPDATE documents SET processing_status = 'PROCESSING' WHERE id = $1", [documentId]);
      const bytes = await storage.get(document.storage_key);
      const extension = document.original_filename.split(".").pop()!.toLowerCase();
      const result = await importBatch(c, tenantId, SYSTEM_USER_ID, batch, bytes, extension);
      await c.query("UPDATE documents SET processing_status = $2 WHERE id = $1",
        [documentId, result.warnings ? "PROCESSED_WITH_WARNINGS" : "PROCESSED_OK"]);
      return finish(c, documentId);
    });
  } catch (error) {
    const permanent = error instanceof ParseError;
    console.error("Falha no processamento", { documentId, attempts, error: (error as Error).message });
    if (permanent || attempts >= MAX_ATTEMPTS) {
      // O arquivo original permanece; o documento vai para a fila de exceção.
      await withContext(pool, context(tenantId), async (c) => {
        await c.query("UPDATE documents SET processing_status = 'PROCESSING' WHERE id = $1", [documentId]);
        if (permanent) await c.query("UPDATE import_batches SET status = 'VALIDATING' WHERE document_id = $1", [documentId]);
        await c.query("UPDATE documents SET processing_status = 'FAILED_PROCESSING', processing_error = $2 WHERE id = $1",
          [documentId, permanent ? error.code : "PROCESSING_FAILED"]);
        await c.query("UPDATE import_batches SET status = $2 WHERE document_id = $1",
          [documentId, permanent ? "REJECTED" : "FAILED_IMPORT"]);
        await finish(c, documentId);
      });
    } else {
      await pool.query(
        "UPDATE app.processing_queue SET next_attempt_at = now() + make_interval(secs => $2) WHERE document_id = $1",
        [documentId, 30 * 2 ** attempts]);
    }
  }
  return true;
}

/** Processa a fila até esvaziar ou até o prazo, para execuções curtas. */
export async function processPending(pool: pg.Pool, storage: FileStorage, budgetMs = 45_000) {
  const until = Date.now() + budgetMs;
  let processed = 0;
  while (Date.now() < until && (await processNext(pool, storage))) processed++;
  return processed;
}
