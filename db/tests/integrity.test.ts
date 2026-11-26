import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { as, bankTx, createTestDb, ctx, insert, installment, operation, seed, type Seed, type TestDb } from "./helpers.ts";

describe("alocações, conciliação e imutabilidade", () => {
  let db: TestDb;
  let s: Seed;
  beforeAll(async () => { db = await createTestDb(); s = await seed(db); });
  afterAll(async () => { await db.close(); });

  const run = <T>(work: (c: pg.PoolClient) => Promise<T>) => as(db, ctx(s.user, s.a.id), work);
  const status = async (table: string, id: string) =>
    (await db.admin.query(`SELECT reconciliation_status AS s FROM ${table} WHERE id=$1`, [id])).rows[0].s;
  const group = (c: pg.PoolClient) => insert(c, "reconciliation_groups",
    { tenant_id: s.a.id, match_method: "MANUAL_BPO", status: "ACTIVE", created_by_user_id: s.user });
  const alloc = (c: pg.PoolClient, g: string, left: string, rightType: string, right: string, amount: string) =>
    insert(c, "reconciliation_allocations", {
      tenant_id: s.a.id, group_id: g, left_entity_type: "BANK_TRANSACTION", left_entity_id: left,
      right_entity_type: rightType, right_entity_id: right, allocated_amount: amount,
    });

  it("N:1 — três parcelas compõem um depósito, com estado parcial e total; reversão preserva histórico", async () => {
    const { tx, g } = await run(async (c) => {
      const tx = await insert(c, "bank_transactions", bankTx(s.a, "1000.00"));
      const g = await group(c);
      const first = await installment(c, s.a, s.user, "300.00");
      await alloc(c, g, tx, "OBLIGATION_INSTALLMENT", first.id, "300.00");
      expect((await c.query("SELECT reconciliation_status s FROM bank_transactions WHERE id=$1", [tx])).rows[0].s)
        .toBe("PARTIALLY_RECONCILED");
      for (const v of ["450.00", "250.00"]) {
        await alloc(c, g, tx, "OBLIGATION_INSTALLMENT", (await installment(c, s.a, s.user, v)).id, v);
      }
      return { tx, g };
    });
    expect(await status("bank_transactions", tx)).toBe("RECONCILED");
    await run((c) => c.query("UPDATE reconciliation_groups SET status='REVERSED' WHERE id=$1", [g]));
    expect(await status("bank_transactions", tx)).toBe("UNRECONCILED");
    expect((await db.admin.query("SELECT 1 FROM reconciliation_allocations WHERE group_id=$1", [g])).rowCount).toBe(3);
    await expect(run((c) => c.query("UPDATE reconciliation_groups SET status='ACTIVE' WHERE id=$1", [g])))
      .rejects.toThrow(/IMMUTABLE_RECORD/);
  });

  it("não deixa alocar acima do valor da movimentação", async () => {
    await expect(run(async (c) => {
      const tx = await insert(c, "bank_transactions", bankTx(s.a, "100.00"));
      const i = await installment(c, s.a, s.user, "500.00");
      await alloc(c, await group(c), tx, "OBLIGATION_INSTALLMENT", i.id, "100.01");
    })).rejects.toThrow(/ALLOCATION_EXCEEDS_BALANCE/);
  });

  it("alocações concorrentes não ultrapassam o saldo (sem deadlock)", async () => {
    const { tx, a, b, g1, g2 } = await run(async (c) => ({
      tx: await insert(c, "bank_transactions", bankTx(s.a, "100.00")),
      a: (await installment(c, s.a, s.user, "80.00")).id, b: (await installment(c, s.a, s.user, "80.00")).id,
      g1: await group(c), g2: await group(c),
    }));
    const results = await Promise.allSettled([
      run((c) => alloc(c, g1, tx, "OBLIGATION_INSTALLMENT", a, "80.00")),
      run((c) => alloc(c, g2, tx, "OBLIGATION_INSTALLMENT", b, "80.00")),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(String((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason))
      .toMatch(/ALLOCATION_EXCEEDS_BALANCE/);
    await expect(run((c) => c.query("UPDATE bank_transactions SET amount=10 WHERE id=$1", [tx])))
      .rejects.toThrow(/ALLOCATION_EXCEEDS_BALANCE/);
  });

  it("operação travada (is_locked) não é editada", async () => {
    const id = await run((c) => insert(c, "economic_operations", operation(s.a, s.user, "5.00", { is_locked: true })));
    await expect(run((c) => c.query("UPDATE economic_operations SET gross_amount=6 WHERE id=$1", [id])))
      .rejects.toThrow(/RECORD_LOCKED/);
  });

  it("transferência interna aceita as duas pernas, e não mais que isso", async () => {
    const t = await run(async (c) => {
      const out = await insert(c, "bank_transactions", bankTx(s.a, "2000.00", { direction: "DEBIT" }));
      const inn = await insert(c, "bank_transactions", bankTx(s.a, "2000.00", { financial_account_id: s.a.bankB }));
      const t = await insert(c, "internal_transfers", { tenant_id: s.a.id, from_account_id: s.a.bankA,
        to_account_id: s.a.bankB, transfer_date: "2026-11-28", amount: "2000.00", outflow_bank_tx_id: out, inflow_bank_tx_id: inn });
      const g = await group(c);
      await alloc(c, g, out, "INTERNAL_TRANSFER", t, "2000.00");
      await alloc(c, g, inn, "INTERNAL_TRANSFER", t, "2000.00");
      return t;
    });
    expect(await status("internal_transfers", t)).toBe("RECONCILED");
    await expect(run(async (c) => {
      const extra = await insert(c, "bank_transactions", bankTx(s.a, "1.00"));
      await alloc(c, await group(c), extra, "INTERNAL_TRANSFER", t, "1.00");
    })).rejects.toThrow(/ALLOCATION_EXCEEDS_BALANCE/);
  });

  it("antecipação total (Cenário 4): não conta o bruto duas vezes e preserva a data original", async () => {
    const parcel = await run(async (c) => {
      const i = await installment(c, s.a, s.user, "5000.00", "100.00");
      const a = await insert(c, "receivable_anticipations", { tenant_id: s.a.id, acquirer_id: s.a.acquirer,
        requested_at: "2026-11-27", effective_date: "2026-11-28", gross_anticipated_amount: "5000.00",
        anticipation_fee_amount: "50.00", net_anticipated_amount: "4850.00" });
      await insert(c, "anticipation_allocations", { tenant_id: s.a.id, anticipation_id: a, installment_id: i.id,
        gross_allocated: "5000.00", fee_allocated: "50.00", net_allocated: "4850.00" });
      const e = await insert(c, "settlement_events", { tenant_id: s.a.id, financial_account_id: s.a.bankA,
        anticipation_id: a, settlement_date: "2026-11-28", gross_amount: "5000.00",
        total_fees_amount: "150.00", net_amount: "4850.00" });
      await insert(c, "settlement_allocations", { tenant_id: s.a.id, settlement_event_id: e, installment_id: i.id,
        allocated_gross_amount: "5000.00", allocated_net_amount: "4850.00" });
      await c.query(`UPDATE obligation_installments SET settled_amount=5000, status='ANTICIPATED_SETTLED',
        current_expected_settlement_date='2026-11-28' WHERE id=$1`, [i.id]);
      return i.id;
    });
    await expect(run((c) => c.query(
      "UPDATE obligation_installments SET original_expected_settlement_date='2026-11-28' WHERE id=$1", [parcel])))
      .rejects.toThrow(/IMMUTABLE_FIELD/);
    await expect(run(async (c) => {
      const e = await insert(c, "settlement_events", { tenant_id: s.a.id, financial_account_id: s.a.bankA,
        settlement_date: "2026-12-25", gross_amount: "1.00", net_amount: "1.00" });
      await insert(c, "settlement_allocations", { tenant_id: s.a.id, settlement_event_id: e, installment_id: parcel,
        allocated_gross_amount: "1.00", allocated_net_amount: "1.00" });
    })).rejects.toThrow(/ALLOCATION_EXCEEDS_BALANCE/);
  });

  it("mesmo FITID na mesma conta não é gravado duas vezes", async () => {
    await run((c) => insert(c, "bank_transactions", bankTx(s.a, "1.00", { external_fitid: "F1" })));
    await expect(run((c) => insert(c, "bank_transactions", bankTx(s.a, "1.00", { external_fitid: "F1" }))))
      .rejects.toThrow(/uq_bank_tx_fitid/);
  });

  it("pendência: CRITICAL não aceita ressalva e bloqueante não se encerra sozinha", async () => {
    const issue = (severity: string, st: string) => run((c) => insert(c, "blocking_issues", {
      tenant_id: s.a.id, competence_date: "2026-11-01", target_entity_type: "BATCH", target_entity_id: s.a.id,
      severity, status: st, title: "t", description: "d", assigned_to_side: "CLIENT", opened_by_user_id: s.user }));
    await expect(issue("CRITICAL", "ACCEPTED_WITH_CAVEAT")).rejects.toThrow(/check/);
    const id = await issue("BLOCKING_OPERATIONAL", "WAITING_CLIENT_RESPONSE");
    await expect(run((c) => c.query("UPDATE blocking_issues SET status='RESOLVED' WHERE id=$1", [id])))
      .rejects.toThrow(/ISSUE_REQUIRES_BPO_VALIDATION/);
  });

  it("fechamento: ressalva exige vínculo; publicado fica imutável; reabertura permite versão 2", async () => {
    const pre = await run(async (c) => ({
      tx: await insert(c, "bank_transactions", bankTx(s.a, "7.00", { bank_posting_date: "2026-10-10" })),
      oct: await installment(c, s.a, s.user, "80.00"),
    }));
    await run((c) => c.query("UPDATE economic_operations SET competence_date='2026-10-05' WHERE id=$1", [pre.oct.op]));
    const period = await run((c) => insert(c, "period_closings",
      { tenant_id: s.a.id, competence_date: "2026-10-01", status: "READY_FOR_REVIEW" }));
    const version = (c: pg.PoolClient, n: number, extra = {}) => insert(c, "closing_versions", {
      tenant_id: s.a.id, period_closing_id: period, version_number: n, closing_type: "PUBLISHED_FULL",
      status: "ACTIVE", snapshot_summary: {}, approved_by_user_id: s.reviewer, ...extra });

    await expect(run((c) => version(c, 1, { closing_type: "PUBLISHED_WITH_CAVEATS", caveat_review_deadline: "2026-12-10",
      caveat_justification: "Comprovante pendente do fornecedor", caveat_responsible_user_id: s.user })))
      .rejects.toThrow(/CAVEAT_REQUIRES_LINKED_ISSUES/);

    const v1 = await run(async (c) => {
      const v = await version(c, 1);
      await c.query("UPDATE period_closings SET status='CLOSED_PUBLISHED', current_version_number=1 WHERE id=$1", [period]);
      return v;
    });

    await expect(run((c) => insert(c, "economic_operations",
      operation(s.a, s.user, "1.00", { competence_date: "2026-10-31" })))).rejects.toThrow(/PERIOD_CLOSED/);
    await expect(run((c) => c.query("UPDATE economic_operations SET gross_amount=1 WHERE id=$1", [pre.oct.op])))
      .rejects.toThrow(/PERIOD_CLOSED/);
    await expect(run((c) => c.query("UPDATE bank_transactions SET amount=8 WHERE id=$1", [pre.tx])))
      .rejects.toThrow(/PERIOD_CLOSED/);
    await expect(run(async (c) => alloc(c, await group(c), pre.tx, "OBLIGATION_INSTALLMENT", pre.oct.id, "7.00")))
      .rejects.toThrow(/PERIOD_CLOSED/);
    // liquidação posterior de parcela de competência fechada continua permitida
    await run((c) => c.query("UPDATE obligation_installments SET settled_amount=80, status='SETTLED' WHERE id=$1", [pre.oct.id]));
    await expect(run((c) => c.query("UPDATE period_closings SET status='IN_PROCESSING' WHERE id=$1", [period])))
      .rejects.toThrow(/PERIOD_CLOSED_REQUIRES_REOPEN/);
    await expect(run((c) => c.query("UPDATE closing_versions SET snapshot_summary='{\"x\":1}' WHERE id=$1", [v1])))
      .rejects.toThrow(/IMMUTABLE_RECORD/);

    await run(async (c) => {
      await c.query("UPDATE period_closings SET status='REOPENED' WHERE id=$1", [period]);
      await c.query("UPDATE economic_operations SET gross_amount=81 WHERE id=$1", [pre.oct.op]);
      await c.query("UPDATE closing_versions SET status='SUPERSEDED' WHERE id=$1", [v1]);
      await version(c, 2);
    });
    const { rows } = await db.admin.query(
      "SELECT version_number v, status FROM closing_versions WHERE period_closing_id=$1 ORDER BY 1", [period]);
    expect(rows).toEqual([{ v: 1, status: "SUPERSEDED" }, { v: 2, status: "ACTIVE" }]);
  });
});
