/** Aplica um relatório de adquirente já validado: vendas, repasses e antecipações. */
import type pg from "pg";
import { conflict, forbidden, AppError } from "../../shared/errors";
import type { Access } from "../identity-access/authorize";
import { total, fixed } from "../financial-core/common";
import { createOperation } from "../financial-core/operations";
import type { AcquirerRow } from "../import-processing/parsers";
import { createAnticipation, createSettlement } from "./cards";

type Item = { id: string; row: AcquirerRow };

export async function applyAcquirerBatch(c: pg.PoolClient, access: Access, batchId: string) {
  const t = access.tenantId;
  const batch = (await c.query(
    `SELECT b.status, b.acquirer_id, b.document_id, q.settlement_account_id FROM import_batches b
       JOIN acquirers q ON q.id = b.acquirer_id
      WHERE b.tenant_id = $1 AND b.id = $2 AND b.source_type = 'ACQUIRER_CSV_XLSX' FOR NO KEY UPDATE OF b`, [t, batchId])).rows[0];
  if (!batch) throw forbidden();
  if (!["READY_TO_IMPORT", "IMPORTED_WITH_EXCEPTIONS"].includes(batch.status)) throw conflict("INVALID_TRANSITION");
  await c.query("UPDATE import_batches SET status = 'IMPORTING' WHERE id = $1", [batchId]);

  const items: Item[] = (await c.query(
    `SELECT id, raw_payload->'parsed' AS row FROM batch_items
      WHERE tenant_id = $1 AND batch_id = $2 AND item_status = 'NEW_VALID' ORDER BY row_number`, [t, batchId])).rows;
  const groups = (type: string, key: (r: AcquirerRow) => string) =>
    [...Map.groupBy(items.filter((i) => i.row.eventType === type), (i) => key(i.row)).values()];

  let applied = 0;
  /** Cada grupo é atômico; o que falha continua pendente com o motivo. */
  const attempt = async (group: Item[], work: () => Promise<{ type: string; id: (i: Item) => string }>) => {
    await c.query("SAVEPOINT item");
    try {
      const target = await work();
      for (const i of group) {
        await c.query(
          "UPDATE batch_items SET item_status = 'COMMITTED', item_note = NULL, target_entity_type = $2, target_entity_id = $3 WHERE id = $1",
          [i.id, target.type, target.id(i)]);
      }
      await c.query("RELEASE SAVEPOINT item");
      applied += group.length;
    } catch (error) {
      await c.query("ROLLBACK TO SAVEPOINT item");
      const known = error instanceof AppError ? error.code
        : /^([A-Z_]{6,}):?/.exec((error as Error).message)?.[1];
      if (!known && !(error as { code?: string }).code?.startsWith("23")) throw error;
      for (const i of group) {
        await c.query("UPDATE batch_items SET item_note = $2 WHERE id = $1", [i.id, known ?? "RULE_VIOLATION"]);
      }
    }
  };

  const installmentOf = async (r: AcquirerRow) => {
    const found = (await c.query(
      `SELECT i.id FROM obligation_installments i JOIN financial_obligations o ON o.id = i.obligation_id
         JOIN economic_operations p ON p.id = o.economic_operation_id
        WHERE i.tenant_id = $1 AND p.acquirer_id = $2 AND p.external_nsu_tid = $3 AND p.operation_type = 'SALE'
          AND p.review_status <> 'REJECTED' AND i.installment_number = $4`,
      [t, batch.acquirer_id, r.nsu, r.installment])).rows[0];
    if (!found) throw new AppError(400, "SALE_NOT_FOUND");
    return found.id as string;
  };

  for (const group of groups("SALE", (r) => r.nsu!)) {
    await attempt(group, async () => {
      const rows = group.map((g) => g.row).sort((a, b) => a.installment! - b.installment!);
      const first = rows[0]!;
      if (rows.length !== first.totalInstallments || rows.some((r, k) => r.installment !== k + 1)) {
        throw new AppError(400, "INCOMPLETE_INSTALLMENTS");
      }
      if (rows.some((r) => !r.expectedDate)) throw new AppError(400, "MISSING_EXPECTED_DATE");
      const sale = await createOperation(c, access, {
        operationType: "SALE", operationDate: first.operationDate, grossAmount: fixed(total(rows.map((r) => r.gross!))),
        description: `Venda cartão NSU ${first.nsu}`, acquirerId: batch.acquirer_id, externalNsuTid: first.nsu,
        sourceDocumentId: batch.document_id,
        installments: rows.map((r) => ({ dueDate: r.expectedDate!, grossAmount: r.gross!, expectedFeeAmount: r.mdr! })),
      }, "BATCH_IMPORT");
      return { type: "OPERATION", id: () => sale.id };
    });
  }

  const lineOf = async ({ row }: Item) => ({
    installmentId: await installmentOf(row), grossAmount: row.gross!, mdrFee: row.mdr!,
    anticipationFee: row.anticipationFee!, fixedFee: row.otherFees!,
  });
  for (const type of ["ANTICIPATION", "SETTLEMENT"]) {
    for (const group of groups(type, (r) => r.settlementDate ?? "")) {
      await attempt(group, async () => {
        const when = group[0]!.row.settlementDate;
        if (!when) throw new AppError(400, "MISSING_SETTLEMENT_DATE");
        // Consultas em série: a conexão da transação não aceita paralelismo.
        const prepared = [];
        for (const item of group) prepared.push(await lineOf(item));
        const common = { financialAccountId: batch.settlement_account_id, acquirerId: batch.acquirer_id,
          items: prepared, netAmount: fixed(total(group.map((g) => g.row.net!))) };
        const result = type === "ANTICIPATION"
          ? await createAnticipation(c, access, { ...common, requestedAt: when, effectiveDate: when, sourceDocumentId: batch.document_id })
          : await createSettlement(c, access, { ...common, settlementDate: when });
        return { type: type === "ANTICIPATION" ? "ANTICIPATION" : "SETTLEMENT", id: () => result.id };
      });
    }
  }

  // CHARGEBACK_REVERSAL exige decisão de Revisor/Master (estorno manual).
  const left = (await c.query(
    "SELECT count(*)::int AS n FROM batch_items WHERE batch_id = $1 AND item_status IN ('NEW_VALID','INVALID_ITEM')", [batchId])).rows[0].n;
  const status = left ? "IMPORTED_WITH_EXCEPTIONS" : "IMPORTED_COMPLETE";
  await c.query(
    `UPDATE import_batches b SET status = $2,
        imported_items = (SELECT count(*) FROM batch_items WHERE batch_id = b.id AND item_status = 'COMMITTED')
      WHERE b.id = $1`, [batchId, status]);
  return { status, applied, pending: left };
}
