/** Fechamento versionado (Doc 1 §2.7; Doc 3 §5). */
import type pg from "pg";
import { z } from "zod";
import { conflict, invalid } from "../../shared/errors";
import type { Access } from "../identity-access/authorize";
import { businessDate } from "../../shared/dates/business-date";
import { tolerance } from "../financial-core/common";
import { fullReport, monthRange } from "./reports";

export const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);

/** Os seis itens do checklist (Doc 3 §5.1) mais a fila de processamento (decisão posterior à especificação). */
export async function checklist(c: pg.PoolClient, tenantId: string, m: string) {
  const [from, to] = monthRange(m);
  const one = async (sql: string, values: unknown[] = [tenantId, from, to]) => (await c.query(sql, values)).rows;
  const balances = await one(
    `SELECT name FROM financial_accounts WHERE tenant_id = $1 AND is_active AND account_type <> 'CORPORATE_CARD'
        AND balance_validated_at IS NULL ORDER BY name`, [tenantId]);
  const issues = await one(
    `SELECT id, title, severity FROM blocking_issues WHERE tenant_id = $1 AND competence_date = $2
        AND severity IN ('CRITICAL','BLOCKING_OPERATIONAL') AND status NOT IN ('RESOLVED','ACCEPTED_WITH_CAVEAT')
      ORDER BY created_at`, [tenantId, from]);
  const batches = await one(
    `SELECT b.id FROM import_batches b JOIN documents d ON d.id = b.document_id
      WHERE b.tenant_id = $1 AND b.status IN ('OVERLAP_REVIEW','FAILED_IMPORT')
        AND (CASE WHEN b.period_start IS NOT NULL THEN b.period_start <= $3 AND b.period_end >= $2
             ELSE COALESCE(d.competence_date, (d.created_at AT TIME ZONE 'America/Sao_Paulo')::date) BETWEEN $2 AND $3 END)`);
  // Arquivo ainda na fila (ou aguardando aplicação) entraria depois do fechamento e falharia com PERIOD_CLOSED.
  // Sem período conhecido, o lote bloqueia todos os meses abertos.
  const queued = await one(
    `SELECT b.id FROM import_batches b JOIN documents d ON d.id = b.document_id
      WHERE b.tenant_id = $1 AND b.status IN ('UPLOADED','VALIDATING','IMPORTING','READY_TO_IMPORT')
        AND (b.period_start IS NULL OR (b.period_start <= $3 AND b.period_end >= $2))`);
  const entries = await one(
    `SELECT id FROM cash_transactions WHERE tenant_id = $1 AND transaction_date BETWEEN $2 AND $3 AND deleted_at IS NULL
        AND review_status IN ('SUBMITTED_PENDING_BPO','UNDER_BPO_REVIEW')
     UNION ALL SELECT id FROM economic_operations WHERE tenant_id = $1 AND competence_date BETWEEN $2 AND $3
        AND deleted_at IS NULL AND review_status IN ('SUBMITTED_PENDING_BPO','UNDER_BPO_REVIEW')`);
  const difference = (await one(
    `SELECT COALESCE(SUM(b.amount - app.allocated_left('BANK_TRANSACTION', b.id)),0)::numeric(15,2) AS v
       FROM bank_transactions b WHERE b.tenant_id = $1 AND b.bank_posting_date BETWEEN $2 AND $3`))[0].v as string;
  const limit = await tolerance(c, tenantId);

  const items = [
    { code: "INITIAL_BALANCES", label: "Saldos iniciais validados", ok: balances.length === 0, detail: balances.map((b) => b.name).join(", ") },
    { code: "NO_CRITICAL", label: "Sem pendências críticas", ok: !issues.some((i) => i.severity === "CRITICAL"),
      detail: issues.filter((i) => i.severity === "CRITICAL").map((i) => i.title).join(", ") },
    { code: "NO_BLOCKING", label: "Sem pendências bloqueantes", ok: !issues.some((i) => i.severity === "BLOCKING_OPERATIONAL"),
      detail: issues.filter((i) => i.severity === "BLOCKING_OPERATIONAL").map((i) => i.title).join(", ") },
    { code: "NO_STUCK_BATCHES", label: "Sem lotes parados", ok: batches.length === 0, detail: batches.length ? `${batches.length} lote(s)` : "" },
    { code: "NO_QUEUED_BATCHES", label: "Sem arquivos na fila de processamento", ok: queued.length === 0,
      detail: queued.length ? `${queued.length} arquivo(s) aguardando` : "" },
    { code: "ENTRIES_REVIEWED", label: "Lançamentos conferidos", ok: entries.length === 0, detail: entries.length ? `${entries.length} aguardando` : "" },
    { code: "RECONCILED", label: "Conciliação bancária dentro da tolerância", ok: !limit.lessThan(difference),
      detail: limit.lessThan(difference) ? `R$ ${difference} sem conciliar` : "" },
  ];
  return { items, ready: items.every((i) => i.ok), blockingIssues: issues.filter((i) => i.severity === "BLOCKING_OPERATIONAL") };
}

async function period(c: pg.PoolClient, tenantId: string, from: string) {
  await c.query(
    `INSERT INTO period_closings (tenant_id, competence_date, status) VALUES ($1,$2,'IN_PROCESSING')
     ON CONFLICT (tenant_id, competence_date) DO NOTHING`, [tenantId, from]);
  // O bloqueio impede que lançamentos entrem enquanto o fechamento é gravado.
  return (await c.query(
    "SELECT id, status, current_version_number AS version FROM period_closings WHERE tenant_id = $1 AND competence_date = $2 FOR UPDATE",
    [tenantId, from])).rows[0] as { id: string; status: string; version: number };
}

const CLOSED = ["CLOSED_PUBLISHED", "CLOSED_WITH_CAVEATS"];

export async function closingStatus(c: pg.PoolClient, access: Access, m: string) {
  month.parse(m);
  const current = (await c.query(
    "SELECT status, current_version_number FROM period_closings WHERE tenant_id = $1 AND competence_date = $2",
    [access.tenantId, `${m}-01`])).rows[0];
  const list = await checklist(c, access.tenantId, m);
  const status = current && (CLOSED.includes(current.status) || current.status === "REOPENED")
    ? current.status : list.ready ? "READY_FOR_REVIEW" : "BLOCKED_BY_ISSUES";
  return { month: m, status, version: current?.current_version_number ?? 0, checklist: list,
    versions: await listVersions(c, access.tenantId, m) };
}

export async function listVersions(c: pg.PoolClient, tenantId: string, m?: string) {
  return (await c.query(
    `SELECT v.id, to_char(p.competence_date,'YYYY-MM') AS month, v.version_number, v.closing_type, v.status,
            v.caveat_justification, v.caveat_review_deadline, v.published_at
       FROM closing_versions v JOIN period_closings p ON p.id = v.period_closing_id
      WHERE v.tenant_id = $1 AND ($2::date IS NULL OR p.competence_date = $2)
      ORDER BY p.competence_date DESC, v.version_number DESC`, [tenantId, m ? `${m}-01` : null])).rows;
}

export async function getVersion(c: pg.PoolClient, tenantId: string, id: string) {
  return (await c.query(
    `SELECT id, version_number, closing_type, status, caveat_justification, caveat_review_deadline, published_at,
            snapshot_summary AS snapshot FROM closing_versions WHERE tenant_id = $1 AND id = $2`, [tenantId, id])).rows[0];
}

export const publishInput = z.strictObject({
  month,
  caveats: z.strictObject({
    justification: z.string().trim().min(20).max(2000),
    reviewDeadline: z.string().refine((v) => { try { businessDate(v); return true; } catch { return false; } }),
    responsibleUserId: z.guid(),
    issueIds: z.array(z.guid()).min(1),
  }).optional(),
});

async function lockRecords(c: pg.PoolClient, tenantId: string, from: string, to: string, lock: boolean) {
  const [was, becomes] = lock ? ["APPROVED_FOR_LEDGER", "LOCKED_IN_CLOSING"] : ["LOCKED_IN_CLOSING", "APPROVED_FOR_LEDGER"];
  await c.query(
    `UPDATE economic_operations SET review_status = $5, is_locked = $6
      WHERE tenant_id = $1 AND competence_date BETWEEN $2 AND $3 AND review_status = $4`,
    [tenantId, from, to, was, becomes, lock]);
  await c.query(
    `UPDATE cash_transactions SET review_status = $5
      WHERE tenant_id = $1 AND transaction_date BETWEEN $2 AND $3 AND review_status = $4`, [tenantId, from, to, was, becomes]);
}

export async function publish(
  c: pg.PoolClient, access: Access, raw: unknown, secondApprover: string | null = null, requester = access.userId,
) {
  const input = publishInput.parse(raw);
  const t = access.tenantId;
  const [from, to] = monthRange(input.month);
  const p = await period(c, t, from);
  if (CLOSED.includes(p.status)) throw conflict("ALREADY_CLOSED");
  const list = await checklist(c, t, input.month);
  const failed = list.items.filter((i) => !i.ok).map((i) => i.code);
  const caveats = input.caveats;
  if (!caveats && failed.length) throw conflict(`CHECKLIST_${failed[0]}`);
  if (caveats) {
    if (failed.includes("INITIAL_BALANCES")) throw conflict("CHECKLIST_INITIAL_BALANCES");
    if (failed.includes("NO_CRITICAL")) throw conflict("CHECKLIST_NO_CRITICAL");
    // Nem a ressalva resolve: o arquivo em fila falharia ao ser processado depois do fechamento.
    if (failed.includes("NO_QUEUED_BATCHES")) throw conflict("CHECKLIST_NO_QUEUED_BATCHES");
    const open = list.blockingIssues.map((i) => i.id as string);
    // A ressalva precisa enumerar exatamente as pendências aceitas.
    if (open.length !== caveats.issueIds.length || !open.every((id) => caveats.issueIds.includes(id))) {
      throw invalid("CAVEAT_ISSUES_MISMATCH");
    }
    // Doc 1 §2.6: respondida precisa ser validada ou devolvida antes de ser ressalvada.
    const answered = await c.query(
      "SELECT 1 FROM blocking_issues WHERE tenant_id = $1 AND id = ANY($2) AND status NOT IN ('OPEN','WAITING_CLIENT_RESPONSE','WAITING_BPO_ACTION')",
      [t, open]);
    if (answered.rowCount) throw conflict("CAVEAT_ISSUE_AWAITING_VALIDATION");
    const responsible = await c.query(
      `SELECT 1 FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2 AND is_active
       UNION SELECT 1 FROM bpo_staff_assignments WHERE tenant_id = $1 AND user_id = $2 AND revoked_at IS NULL
       UNION SELECT 1 WHERE $2 = $3`, [t, caveats.responsibleUserId, access.userId]);
    if (!responsible.rowCount) throw invalid("INVALID_ASSIGNEE");
  }

  // O retrato é calculado antes de travar, já com o conteúdo definitivo.
  const snapshot = { ...(await fullReport(c, t, input.month, !!caveats)), checklist: list.items,
    caveatIssues: caveats ? list.blockingIssues : [] };
  // Doc 1 §2.7: passa pelo estado intermediário antes de fechar.
  const step = !caveats ? "READY_FOR_REVIEW" : p.status === "REOPENED" ? null : "BLOCKED_BY_ISSUES";
  if (step) await c.query("UPDATE period_closings SET status = $2 WHERE id = $1", [p.id, step]);
  await lockRecords(c, t, from, to, true);
  const version = p.version + 1;
  const type = caveats ? "PUBLISHED_WITH_CAVEATS" : "PUBLISHED_FULL";
  await c.query("UPDATE closing_versions SET status = 'SUPERSEDED' WHERE period_closing_id = $1 AND status = 'ACTIVE'", [p.id]);
  const id = (await c.query(
    `INSERT INTO closing_versions (tenant_id, period_closing_id, version_number, closing_type, status, caveat_justification,
        caveat_review_deadline, caveat_responsible_user_id, snapshot_summary, approved_by_user_id, second_approver_user_id)
     VALUES ($1,$2,$3,$4,'ACTIVE',$5,$6,$7,$8,$9,$10) RETURNING id`,
    [t, p.id, version, type, caveats?.justification ?? null, caveats?.reviewDeadline ?? null,
     caveats?.responsibleUserId ?? null, JSON.stringify(snapshot), requester, secondApprover])).rows[0].id as string;
  for (const issue of caveats?.issueIds ?? []) {
    await c.query("INSERT INTO closing_version_issues (tenant_id, closing_version_id, blocking_issue_id) VALUES ($1,$2,$3)", [t, id, issue]);
    await c.query("UPDATE blocking_issues SET status = 'ACCEPTED_WITH_CAVEAT' WHERE tenant_id = $1 AND id = $2", [t, issue]);
  }
  await c.query("UPDATE period_closings SET status = $2, current_version_number = $3 WHERE id = $1",
    [p.id, caveats ? "CLOSED_WITH_CAVEATS" : "CLOSED_PUBLISHED", version]);
  return { id, version, closingType: type };
}

export const reopenInput = z.strictObject({ month, reason: z.string().trim().min(10).max(1000) });

export async function reopenPeriod(c: pg.PoolClient, access: Access, raw: unknown) {
  const input = reopenInput.parse(raw);
  const [from, to] = monthRange(input.month);
  const p = await period(c, access.tenantId, from);
  if (!CLOSED.includes(p.status)) throw conflict("INVALID_TRANSITION");
  await c.query("SELECT set_config('app.change_reason', $1, true)", [input.reason]);
  await c.query("UPDATE period_closings SET status = 'REOPENED' WHERE id = $1", [p.id]);
  await lockRecords(c, access.tenantId, from, to, false);
  return { status: "REOPENED" };
}

export async function validateBalance(c: pg.PoolClient, access: Access, accountId: string) {
  const { rowCount } = await c.query(
    `UPDATE financial_accounts SET balance_validated_at = now(), balance_validated_by = $3
      WHERE tenant_id = $1 AND id = $2 AND balance_validated_at IS NULL`, [access.tenantId, accountId, access.userId]);
  if (!rowCount) throw conflict("INVALID_TRANSITION");
  return { validated: true };
}

export async function listAccountsForValidation(c: pg.PoolClient, access: Access) {
  return (await c.query(
    `SELECT id, name, initial_balance, initial_balance_date, balance_validated_at FROM financial_accounts
      WHERE tenant_id = $1 AND is_active AND account_type <> 'CORPORATE_CARD' ORDER BY name`, [access.tenantId])).rows;
}
