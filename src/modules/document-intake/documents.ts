import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { z } from "zod";
import { businessDate } from "../../shared/dates/business-date";
import { AppError, conflict, forbidden, invalid } from "../../shared/errors";
import { can, type Access, type Resource } from "../identity-access/authorize";
import type { Principal } from "../identity-access/principal";
import { inTenant } from "../identity-access/tenant-access";
import { mappingInput } from "../import-processing/parsers";
import type { FileStorage } from "./storage";
import { checkFile, MAX_FILE_BYTES, safeName } from "./validation";

const date = z.string().refine((v) => { try { businessDate(v); return true; } catch { return false; } });
const amount = z.string().regex(/^-?\d{1,13}(\.\d{1,2})?$/);

export const uploadInput = z.strictObject({
  docCategory: z.enum(["BANK_STATEMENT", "ACQUIRER_REPORT", "INVOICE_NFE", "BOLETO", "RECEIPT", "CASH_SUMMARY", "OTHER"]),
  businessUnitId: z.guid().optional(),
  financialAccountId: z.guid().optional(),
  acquirerId: z.guid().optional(),
  competenceDate: date.optional(),
  mapping: mappingInput.optional(),
  /** Saldos do extrato, quando o usuário quiser a conferência (Doc 3 §1.1). */
  openingBalance: amount.optional(),
  closingBalance: amount.optional(),
});

const BATCH: Record<string, { sourceType: string; extensions: string[] }> = {
  BANK_STATEMENT: { sourceType: "BANK_OFX_CSV", extensions: ["ofx", "csv", "xlsx"] },
  ACQUIRER_REPORT: { sourceType: "ACQUIRER_CSV_XLSX", extensions: ["csv", "xlsx"] },
};

export async function uploadDocument(
  pool: pg.Pool, storage: FileStorage, principal: Principal, tenantId: string,
  file: { name: string; bytes: Buffer }, raw: unknown,
) {
  const input = uploadInput.parse(raw);
  if (file.bytes.length > MAX_FILE_BYTES) throw new AppError(413, "FILE_TOO_LARGE");
  const check = checkFile(file.name, file.bytes);
  const name = safeName(file.name);
  const resource: Resource = {
    businessUnitId: input.businessUnitId ?? null,
    financialAccountId: input.financialAccountId,
  };

  // Autoriza antes de enviar qualquer byte ao storage.
  const plan = await inTenant(pool, principal, tenantId, { permission: "documents.upload", resource }, async (c, a) => {
    // Envio de funcionário vai só para triagem: não gera movimentação automaticamente.
    const batch = check.ok && !a.roles.includes("CLIENT_EMPLOYEE") && BATCH[input.docCategory]?.extensions.includes(check.extension)
      ? BATCH[input.docCategory] : undefined;
    if (batch?.sourceType === "BANK_OFX_CSV" && !input.financialAccountId) throw invalid("FINANCIAL_ACCOUNT_REQUIRED");
    if (batch?.sourceType === "ACQUIRER_CSV_XLSX" && !input.acquirerId) throw invalid("ACQUIRER_REQUIRED");
    if (input.financialAccountId) {
      const account = (await c.query(
        "SELECT business_unit_id FROM financial_accounts WHERE tenant_id = $1 AND id = $2",
        [a.tenantId, input.financialAccountId])).rows[0];
      // A conta de outra unidade não pode ser usada para contornar o escopo.
      if (!account || (account.business_unit_id && input.businessUnitId && account.business_unit_id !== input.businessUnitId)) {
        throw invalid("INVALID_REFERENCE");
      }
    }
    return { batch, role: a.roles[0]!, tenantId: a.tenantId };
  });

  const documentId = randomUUID();
  const sha256 = createHash("sha256").update(file.bytes).digest("hex");
  const key = `${plan.tenantId}/${documentId}/original`;
  const channel = plan.role.startsWith("CLIENT_") ? "WEB_PORTAL" : "BPO_UPLOAD";
  if (check.ok) await storage.put(key, file.bytes, check.mimeType);

  try {
    return await inTenant(pool, principal, tenantId, { permission: "documents.upload", resource }, async (c, a) => {
      const duplicate = check.ok && !plan.batch ? (await c.query(
        `SELECT f.document_id FROM document_files f JOIN documents d ON d.id = f.document_id
          WHERE f.tenant_id = $1 AND f.sha256_hash = $2 AND f.file_role = 'ORIGINAL'
          ORDER BY f.created_at LIMIT 1`, [a.tenantId, sha256])).rows[0]?.document_id ?? null : null;
      await c.query(
        `INSERT INTO documents (id, tenant_id, business_unit_id, uploaded_by_user_id, origin_channel, doc_category,
           competence_date, receipt_status, processing_status, rejection_reason, duplicate_of_document_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [documentId, a.tenantId, input.businessUnitId ?? null, a.userId, channel, input.docCategory,
         input.competenceDate ?? null, check.ok ? "RECEIVED" : "REJECTED_INVALID",
         plan.batch ? "QUEUED" : "NOT_STARTED", check.ok ? null : check.reason, duplicate]);
      // Arquivo rejeitado não é armazenado nem processado.
      if (!check.ok) return { id: documentId, receiptStatus: "REJECTED_INVALID", rejectionReason: check.reason };

      await c.query(
        `INSERT INTO document_files (tenant_id, document_id, file_role, storage_bucket, storage_key,
           original_filename, mime_type, file_size_bytes, sha256_hash)
         VALUES ($1,$2,'ORIGINAL',$3,$4,$5,$6,$7,$8)`,
        [a.tenantId, documentId, storage.bucket, key, name, check.mimeType, file.bytes.length, sha256]);

      let batchId: string | null = null;
      if (plan.batch) {
        batchId = randomUUID();
        await c.query(
          `INSERT INTO import_batches (id, tenant_id, document_id, source_type, idempotency_key, parser_version,
             status, financial_account_id, acquirer_id, file_sha256, parser_config)
           VALUES ($1,$2,$3,$4,$5,'1','UPLOADED',$6,$7,$8,$9)`,
          [batchId, a.tenantId, documentId, plan.batch.sourceType, `doc:${documentId}`,
           plan.batch.sourceType === "BANK_OFX_CSV" ? input.financialAccountId : null,
           plan.batch.sourceType === "ACQUIRER_CSV_XLSX" ? input.acquirerId : null, sha256,
           JSON.stringify({ mapping: input.mapping, openingBalance: input.openingBalance, closingBalance: input.closingBalance })]);
        await c.query("INSERT INTO app.processing_queue (document_id, tenant_id) VALUES ($1,$2)", [documentId, a.tenantId]);
      }
      return {
        id: documentId, batchId, receiptStatus: "RECEIVED",
        processingStatus: plan.batch ? "QUEUED" : "NOT_STARTED",
        // Funcionário não é informado sobre documentos de terceiros.
        duplicateOfDocumentId: a.roles.includes("CLIENT_EMPLOYEE") ? null : duplicate,
      };
    });
  } catch (error) {
    if (check.ok) await storage.remove(key);
    throw error;
  }
}

const VIEW = `
  SELECT d.id, d.business_unit_id, d.uploaded_by_user_id, d.origin_channel, d.doc_category, d.competence_date,
         d.receipt_status, d.processing_status, d.review_status, d.rejection_reason, d.processing_error,
         d.review_note, d.created_at, f.original_filename, f.file_size_bytes, b.id AS batch_id, b.status AS batch_status
    FROM documents d
    LEFT JOIN document_files f ON f.document_id = d.id AND f.file_role = 'ORIGINAL'
    LEFT JOIN import_batches b ON b.document_id = d.id
   WHERE d.tenant_id = $1 AND d.deleted_at IS NULL AND ($2::uuid IS NULL OR d.uploaded_by_user_id = $2)
     AND ($3::uuid IS NULL OR d.id = $3) AND ($4::text IS NULL OR d.review_status = $4)
   ORDER BY d.created_at, d.id LIMIT 500`;

/** Lista (fila de triagem, em ordem de chegada) ou um documento. */
export async function listDocuments(c: pg.PoolClient, access: Access, filter: { id?: string; reviewStatus?: string } = {}) {
  const ownOnly = access.roles.includes("CLIENT_EMPLOYEE") ? access.userId : null;
  const { rows } = await c.query(VIEW, [access.tenantId, ownOnly, filter.id ?? null, filter.reviewStatus ?? null]);
  return rows.filter((r) => can(access, "documents.view", { ownerUserId: r.uploaded_by_user_id }));
}

export async function downloadUrl(c: pg.PoolClient, access: Access, storage: FileStorage, documentId: string) {
  const [document] = await listDocuments(c, access, { id: documentId });
  if (!document) throw forbidden();
  const file = (await c.query(
    "SELECT storage_key, original_filename FROM document_files WHERE tenant_id = $1 AND document_id = $2 AND file_role = 'ORIGINAL'",
    [access.tenantId, documentId])).rows[0];
  if (!file) throw conflict("NO_FILE");
  return { url: await storage.signedUrl(file.storage_key, file.original_filename) };
}

/** Conferência / triagem (Doc 1 §2.1, dimensão C). */
const REVIEW: Record<string, { from: string[]; to: string; note?: boolean }> = {
  START: { from: ["UNREVIEWED", "NEEDS_INFO"], to: "IN_REVIEW" },
  APPROVE: { from: ["IN_REVIEW"], to: "APPROVED" },
  REJECT: { from: ["IN_REVIEW"], to: "REJECTED", note: true },
  REQUEST_INFO: { from: ["IN_REVIEW"], to: "NEEDS_INFO", note: true },
  ARCHIVE: { from: ["APPROVED", "REJECTED"], to: "ARCHIVED" },
};

export const reviewInput = z.strictObject({
  action: z.enum(["START", "APPROVE", "REJECT", "REQUEST_INFO", "ARCHIVE"]),
  note: z.string().trim().min(3).max(1000).optional(),
});

export async function reviewDocument(c: pg.PoolClient, access: Access, documentId: string, raw: unknown) {
  const input = reviewInput.parse(raw);
  const rule = REVIEW[input.action]!;
  if (rule.note && !input.note) throw invalid("NOTE_REQUIRED");
  const { rowCount } = await c.query(
    `UPDATE documents SET review_status = $3, review_note = COALESCE($4, review_note)
      WHERE tenant_id = $1 AND id = $2 AND receipt_status = 'RECEIVED' AND review_status = ANY($5)
        AND ($3 <> 'APPROVED' OR processing_status NOT IN ('QUEUED','PROCESSING'))`,
    [access.tenantId, documentId, rule.to, input.note ?? null, rule.from]);
  if (!rowCount) throw conflict("INVALID_TRANSITION");
  return { reviewStatus: rule.to };
}

export async function reprocessDocument(c: pg.PoolClient, access: Access, documentId: string) {
  // Só reprocessa o que não efetivou itens: lote rejeitado ou com falha.
  const batch = (await c.query(
    `UPDATE import_batches b SET status = 'UPLOADED' FROM documents d
      WHERE d.id = b.document_id AND b.tenant_id = $1 AND b.document_id = $2
        AND d.processing_status = 'FAILED_PROCESSING' AND b.status IN ('UPLOADED','REJECTED','FAILED_IMPORT')
        AND NOT EXISTS (SELECT 1 FROM batch_items i WHERE i.batch_id = b.id)
      RETURNING b.id`, [access.tenantId, documentId])).rowCount;
  if (!batch) throw conflict("INVALID_TRANSITION");
  await c.query("UPDATE documents SET processing_status = 'QUEUED', processing_error = NULL WHERE tenant_id = $1 AND id = $2",
    [access.tenantId, documentId]);
  await c.query(
    `INSERT INTO app.processing_queue (document_id, tenant_id) VALUES ($1,$2)
     ON CONFLICT (document_id) DO UPDATE SET attempts = 0, next_attempt_at = now()`, [documentId, access.tenantId]);
  return { processingStatus: "QUEUED" };
}
