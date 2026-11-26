/** Classificação, deduplicação e efetivação de lotes (Doc 3 §1; Doc 1 §2.2). */
import { createHash } from "node:crypto";
import type pg from "pg";
import { Decimal } from "decimal.js";
import { z } from "zod";
import { conflict, forbidden } from "../../shared/errors";
import type { Access } from "../identity-access/authorize";
import { openSystemIssue } from "../issues-approvals/issues";
import { parseAcquirerReport, parseBankStatement, type BankRow, type Mapping } from "./parsers";

const sha = (...parts: string[]) => createHash("sha256").update(parts.join("\u001f")).digest("hex");
export const normalizeDescription = (d: string) =>
  d.normalize("NFD").replace(/\p{M}/gu, "").toUpperCase().replace(/\s+/g, " ").trim();

interface Batch {
  id: string; document_id: string; source_type: string; status: string; file_sha256: string;
  financial_account_id: string | null; acquirer_id: string | null;
  parser_config: { mapping?: Mapping; openingBalance?: string; closingBalance?: string } | null;
}

interface Item {
  row: number; externalId?: string; fingerprint: string; raw: unknown; status: string; note?: string;
}

const setBatch = (c: pg.PoolClient, id: string, status: string) =>
  c.query("UPDATE import_batches SET status = $2 WHERE id = $1", [id, status]);

async function insertItems(c: pg.PoolClient, tenantId: string, batchId: string, items: Item[]) {
  await c.query(
    `INSERT INTO batch_items (tenant_id, batch_id, row_number, external_item_id, dedup_fingerprint, raw_payload, item_status, item_note)
     SELECT $1, $2, x.row, x."externalId", x.fingerprint, x.raw, x.status, x.note
       FROM jsonb_to_recordset($3::jsonb) AS x(row int, "externalId" text, fingerprint text, raw jsonb, status text, note text)`,
    [tenantId, batchId, JSON.stringify(items)]);
}

const contentOf = (r: BankRow) => [r.date!, r.direction!, r.amount!, normalizeDescription(r.description!)].join("|");

async function classifyBank(c: pg.PoolClient, tenantId: string, batch: Batch, rows: BankRow[]): Promise<Item[]> {
  const account = batch.financial_account_id!;
  const dates = rows.flatMap((r) => (r.date ? [r.date] : [])).sort();
  const existing = (await c.query(
    `SELECT external_fitid, bank_posting_date, direction, amount FROM bank_transactions
      WHERE tenant_id = $1 AND financial_account_id = $2
        AND (external_fitid = ANY($3) OR bank_posting_date BETWEEN $4 AND $5)`,
    [tenantId, account, rows.flatMap((r) => (r.fitid ? [r.fitid] : [])), dates[0] ?? null, dates.at(-1) ?? null])).rows;
  const known = new Set(existing.map((e) => e.external_fitid).filter(Boolean));
  const periods = (await c.query(
    `SELECT period_start, period_end FROM import_batches
      WHERE tenant_id = $1 AND financial_account_id = $2 AND id <> $3 AND period_start IS NOT NULL
        AND status IN ('OVERLAP_REVIEW','IMPORTED_COMPLETE','IMPORTED_WITH_EXCEPTIONS','PARTIALLY_IMPORTED')`,
    [tenantId, account, batch.id])).rows;
  const closed = new Set((await c.query(
    "SELECT competence_date FROM period_closings WHERE tenant_id = $1 AND status IN ('CLOSED_PUBLISHED','CLOSED_WITH_CAVEATS')",
    [tenantId])).rows.map((r) => r.competence_date.slice(0, 7)));

  const sequence = new Map<string, number>();
  const seen = new Map<string, string>(); // fitid -> conteúdo
  // Mesma composição já efetivada (itens sem ID) também pede decisão humana.
  const counter = new Map<string, number>();
  const candidates = rows.filter((r) => !r.error && !r.fitid).map((r) => {
    const content = contentOf(r);
    counter.set(content, (counter.get(content) ?? 0) + 1);
    return sha(tenantId, account, content, String(counter.get(content)));
  });
  const committed = new Set((await c.query(
    "SELECT dedup_fingerprint FROM batch_items WHERE tenant_id = $1 AND item_status = 'COMMITTED' AND dedup_fingerprint = ANY($2)",
    [tenantId, candidates])).rows.map((r) => r.dedup_fingerprint));

  return rows.map((r) => {
    const base = { row: r.rowNumber, externalId: r.fitid, raw: { ...r.raw, parsed: r.error ? null : {
      date: r.date, direction: r.direction, amount: r.amount, description: r.description, fitid: r.fitid ?? null } } };
    if (r.error) return { ...base, fingerprint: sha(tenantId, account, batch.id, String(r.rowNumber)), status: "INVALID_ITEM", note: r.error };

    const content = contentOf(r);
    const index = (sequence.get(content) ?? 0) + 1;
    sequence.set(content, index);
    const fingerprint = r.fitid ? sha(tenantId, account, r.fitid) : sha(tenantId, account, content, String(index));
    const item = (status: string, note?: string) => ({ ...base, fingerprint, status, note });

    if (closed.has(r.date!.slice(0, 7))) return item("INVALID_ITEM", "PERIOD_CLOSED");
    if (r.fitid) {
      const previous = seen.get(r.fitid);
      seen.set(r.fitid, content);
      if (previous !== undefined) {
        return previous === content ? item("DUPLICATE_ITEM", "REPEATED_IN_FILE") : item("AMBIGUOUS_OVERLAP", "SAME_ID_DIFFERENT_CONTENT");
      }
      if (known.has(r.fitid)) return item("DUPLICATE_ITEM", "ALREADY_IMPORTED");
    }
    // Sem identificador forte dos dois lados: parecido não é prova de duplicidade.
    const suspect = committed.has(fingerprint) || periods.some((p) => r.date! >= p.period_start && r.date! <= p.period_end) &&
      existing.some((e) => e.bank_posting_date === r.date && e.direction === r.direction &&
        new Decimal(e.amount).equals(r.amount!) && (!r.fitid || !e.external_fitid));
    return suspect ? item("AMBIGUOUS_OVERLAP", "SIMILAR_TRANSACTION_IN_OVERLAPPING_PERIOD") : item("NEW_VALID");
  });
}

/** Cria as movimentações bancárias dos itens informados. Idempotente por item. */
async function commitItems(c: pg.PoolClient, tenantId: string, batch: Batch, statuses: string[]) {
  // Outro lote pode ter efetivado o mesmo item enquanto este aguardava decisão.
  await c.query(
    `UPDATE batch_items i SET item_status = 'REJECTED', item_note = 'ALREADY_IMPORTED'
      WHERE i.tenant_id = $1 AND i.batch_id = $2 AND i.item_status = ANY($3) AND (
        EXISTS (SELECT 1 FROM batch_items o WHERE o.tenant_id = $1 AND o.item_status = 'COMMITTED'
                 AND o.dedup_fingerprint = i.dedup_fingerprint)
        OR (i.item_note IS DISTINCT FROM 'SAME_ID_DIFFERENT_CONTENT' AND EXISTS (
              SELECT 1 FROM bank_transactions t WHERE t.tenant_id = $1 AND t.financial_account_id = $4
                 AND t.external_fitid = i.raw_payload->'parsed'->>'fitid')))`,
    [tenantId, batch.id, statuses, batch.financial_account_id]);
  await c.query(
    `INSERT INTO bank_transactions (tenant_id, financial_account_id, batch_item_id, external_fitid,
        bank_posting_date, direction, amount, description)
     SELECT tenant_id, $3, id,
            CASE WHEN item_note = 'SAME_ID_DIFFERENT_CONTENT' THEN NULL ELSE raw_payload->'parsed'->>'fitid' END,
            (raw_payload->'parsed'->>'date')::date, raw_payload->'parsed'->>'direction',
            (raw_payload->'parsed'->>'amount')::numeric, raw_payload->'parsed'->>'description'
       FROM batch_items WHERE tenant_id = $1 AND batch_id = $2 AND item_status = ANY($4)
      ORDER BY row_number`, [tenantId, batch.id, batch.financial_account_id, statuses]);
  await c.query(
    `UPDATE batch_items i SET item_status = 'COMMITTED', target_entity_type = 'BANK_TRANSACTION', target_entity_id = t.id
       FROM bank_transactions t WHERE i.tenant_id = $1 AND i.batch_id = $2 AND t.batch_item_id = i.id
        AND i.item_status = ANY($3)`, [tenantId, batch.id, statuses]);
}

async function refreshCounts(c: pg.PoolClient, batchId: string) {
  await c.query(
    `UPDATE import_batches b SET total_items = s.total, imported_items = s.imported, duplicate_items = s.duplicates
       FROM (SELECT count(*) AS total, count(*) FILTER (WHERE item_status = 'COMMITTED') AS imported,
                    count(*) FILTER (WHERE item_status IN ('DUPLICATE_ITEM','IGNORED_DUPLICATE','IGNORED')) AS duplicates
               FROM batch_items WHERE batch_id = $1) s WHERE b.id = $1`, [batchId]);
}

/**
 * Processa um lote enviado. Roda inteiro numa transação: falha desfaz tudo e a
 * nova tentativa parte do mesmo estado, sem duplicar.
 */
export async function importBatch(
  c: pg.PoolClient, tenantId: string, uploadedBy: string, batch: Batch, bytes: Buffer, extension: string,
): Promise<{ status: string; warnings: boolean }> {
  // Serializa lotes da mesma origem para a deduplicação enxergar o anterior.
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 1))",
    [`${tenantId}:${batch.financial_account_id ?? batch.acquirer_id}`]);
  await setBatch(c, batch.id, "VALIDATING");

  const same = (await c.query(
    `SELECT 1 FROM import_batches WHERE tenant_id = $1 AND id <> $2 AND file_sha256 = $3
        AND financial_account_id IS NOT DISTINCT FROM $4 AND acquirer_id IS NOT DISTINCT FROM $5
        AND status IN ('OVERLAP_REVIEW','READY_TO_IMPORT','IMPORTED_COMPLETE','IMPORTED_WITH_EXCEPTIONS','PARTIALLY_IMPORTED')`,
    [tenantId, batch.id, batch.file_sha256, batch.financial_account_id, batch.acquirer_id])).rowCount;
  if (same) {
    await setBatch(c, batch.id, "DUPLICATE_FILE");
    return { status: "DUPLICATE_FILE", warnings: true };
  }
  const config = batch.parser_config ?? {};

  if (batch.source_type === "ACQUIRER_CSV_XLSX") {
    const rows = await parseAcquirerReport(bytes, extension, config.mapping);
    // Chave forte: adquirente + NSU + parcela + tipo de evento (venda e liquidação do mesmo NSU são fatos distintos).
    const keys = rows.map((r) => r.error ? sha(tenantId, batch.id, String(r.rowNumber))
      : sha(tenantId, batch.acquirer_id!, r.nsu!, String(r.installment), r.eventType!));
    const known = new Set((await c.query(
      `SELECT i.dedup_fingerprint FROM batch_items i JOIN import_batches b ON b.id = i.batch_id
        WHERE i.tenant_id = $1 AND i.dedup_fingerprint = ANY($2) AND i.item_status IN ('NEW_VALID','COMMITTED')
          AND b.status <> 'REJECTED'`, [tenantId, keys])).rows.map((r) => r.dedup_fingerprint));
    const items = rows.map((r, n): Item => {
      const key = keys[n]!;
      const repeated = known.has(key);
      known.add(key);
      return { row: r.rowNumber, externalId: r.nsu, fingerprint: key, raw: { ...r.raw, parsed: r.error ? null : r },
        status: r.error ? "INVALID_ITEM" : repeated ? "DUPLICATE_ITEM" : "NEW_VALID",
        note: r.error ?? (repeated ? "ALREADY_IMPORTED" : undefined) };
    });
    await insertItems(c, tenantId, batch.id, items);
    const dates = rows.flatMap((r) => (r.operationDate ? [r.operationDate] : [])).sort();
    await c.query("UPDATE import_batches SET period_start = $2, period_end = $3 WHERE id = $1",
      [batch.id, dates[0] ?? null, dates.at(-1) ?? null]);
    // Vendas, parcelas e repasses são criados pelo motor financeiro (Etapa 4).
    await setBatch(c, batch.id, "READY_TO_IMPORT");
    await refreshCounts(c, batch.id);
    const invalid = items.filter((i) => i.status === "INVALID_ITEM").length;
    if (invalid) {
      await openSystemIssue(c, tenantId, uploadedBy, {
        competenceDate: dates.at(-1), targetType: "BATCH", targetId: batch.id, severity: "BLOCKING_OPERATIONAL",
        title: "Linhas inválidas no relatório da adquirente", description: `${invalid} linha(s) precisam de revisão.`,
      });
    }
    return { status: "READY_TO_IMPORT", warnings: invalid > 0 };
  }

  const statement = await parseBankStatement(bytes, extension, config.mapping);
  await c.query("UPDATE import_batches SET period_start = $2, period_end = $3 WHERE id = $1",
    [batch.id, statement.periodStart ?? null, statement.periodEnd ?? null]);
  const items = await classifyBank(c, tenantId, batch, statement.rows);
  await insertItems(c, tenantId, batch.id, items);
  const count = (s: string) => items.filter((i) => i.status === s).length;

  // Doc 3 §1.1: confere os saldos quando informados.
  let mismatch = false;
  if (config.openingBalance !== undefined && config.closingBalance !== undefined) {
    const total = statement.rows.reduce((acc, r) => r.error ? acc
      : r.direction === "CREDIT" ? acc.plus(r.amount!) : acc.minus(r.amount!), new Decimal(config.openingBalance));
    mismatch = !total.equals(config.closingBalance);
    if (mismatch) {
      await openSystemIssue(c, tenantId, uploadedBy, {
        competenceDate: statement.periodEnd, targetType: "BATCH", targetId: batch.id, severity: "CRITICAL",
        title: "Saldo do extrato não confere",
        description: `Saldo calculado ${total.toFixed(2)}; saldo final informado ${config.closingBalance}.`,
      });
    }
  }

  let status: string;
  if (count("AMBIGUOUS_OVERLAP") > 0) {
    status = "OVERLAP_REVIEW"; // nada é efetivado antes da decisão humana
  } else {
    await setBatch(c, batch.id, "READY_TO_IMPORT");
    await setBatch(c, batch.id, "IMPORTING");
    await commitItems(c, tenantId, batch, ["NEW_VALID"]);
    status = count("INVALID_ITEM") > 0 || mismatch ? "IMPORTED_WITH_EXCEPTIONS" : "IMPORTED_COMPLETE";
  }
  await setBatch(c, batch.id, status);
  await refreshCounts(c, batch.id);
  return { status, warnings: status !== "IMPORTED_COMPLETE" || mismatch };
}

export async function getBatch(c: pg.PoolClient, access: Access, batchId: string) {
  const batch = (await c.query(
    `SELECT id, document_id, source_type, status, period_start, period_end, total_items, imported_items, duplicate_items
       FROM import_batches WHERE tenant_id = $1 AND id = $2`, [access.tenantId, batchId])).rows[0];
  if (!batch) throw forbidden();
  const items = (await c.query(
    `SELECT id, row_number, external_item_id, item_status, item_note, raw_payload FROM batch_items
      WHERE tenant_id = $1 AND batch_id = $2 ORDER BY row_number`, [access.tenantId, batchId])).rows;
  return { ...batch, items };
}

export const overlapInput = z.strictObject({
  decisions: z.array(z.strictObject({
    itemId: z.guid(),
    decision: z.enum(["COMMIT", "IGNORE_DUPLICATE", "REJECT"]),
    reason: z.string().trim().min(3).max(300),
  })).min(1).max(1000),
});

/** Decisão humana sobre itens ambíguos. Ao decidir o último, o lote é efetivado. */
export async function resolveOverlap(c: pg.PoolClient, access: Access, batchId: string, raw: unknown) {
  const { decisions } = overlapInput.parse(raw);
  const batch = (await c.query(
    "SELECT * FROM import_batches WHERE tenant_id = $1 AND id = $2 FOR NO KEY UPDATE", [access.tenantId, batchId])).rows[0] as Batch | undefined;
  if (!batch) throw forbidden();
  if (batch.status !== "OVERLAP_REVIEW") throw conflict("INVALID_TRANSITION");

  for (const d of decisions) {
    // COMMIT apenas marca; a efetivação é única, quando não restar dúvida.
    const status = d.decision === "COMMIT" ? "AMBIGUOUS_OVERLAP" : d.decision === "REJECT" ? "REJECTED" : "IGNORED_DUPLICATE";
    const note = d.decision === "COMMIT" ? "CONFIRMED_NEW" : d.reason;
    const { rowCount } = await c.query(
      `UPDATE batch_items SET item_status = $4,
          item_note = CASE WHEN $5 = 'CONFIRMED_NEW' AND item_note = 'SAME_ID_DIFFERENT_CONTENT' THEN item_note ELSE $5 END,
          dedup_fingerprint = CASE WHEN $5 = 'CONFIRMED_NEW'
            THEN encode(sha256(convert_to(dedup_fingerprint || id::text, 'UTF8')), 'hex') ELSE dedup_fingerprint END,
          raw_payload = raw_payload || jsonb_build_object('decision', jsonb_build_object('value', $6::text, 'reason', $7::text))
        WHERE tenant_id = $1 AND batch_id = $2 AND id = $3 AND item_status = 'AMBIGUOUS_OVERLAP'
          AND NOT raw_payload ? 'decision'`,
      [access.tenantId, batchId, d.itemId, status, note, d.decision, d.reason]);
    if (!rowCount) throw conflict("ITEM_NOT_PENDING");
  }

  const pending = (await c.query(
    "SELECT 1 FROM batch_items WHERE batch_id = $1 AND item_status = 'AMBIGUOUS_OVERLAP' AND NOT raw_payload ? 'decision' LIMIT 1",
    [batchId])).rowCount;
  if (!pending) {
    await setBatch(c, batchId, "READY_TO_IMPORT");
    await setBatch(c, batchId, "IMPORTING");
    await commitItems(c, access.tenantId, batch, ["NEW_VALID", "AMBIGUOUS_OVERLAP"]);
    const partial = (await c.query(
      "SELECT 1 FROM batch_items WHERE batch_id = $1 AND item_status IN ('REJECTED','INVALID_ITEM') LIMIT 1", [batchId])).rowCount;
    await setBatch(c, batchId, partial ? "IMPORTED_WITH_EXCEPTIONS" : "IMPORTED_COMPLETE");
  }
  await refreshCounts(c, batchId);
  return getBatch(c, access, batchId);
}
