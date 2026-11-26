/** Etapa 3: rotas e worker reais, banco real; storage em memória. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setDeps } from "../../src/server/container.ts";
import { processNext } from "../../src/modules/import-processing/worker.ts";
import type { FileStorage } from "../../src/modules/document-intake/storage.ts";
import * as documentsRoute from "../../src/app/api/tenants/[tenantId]/documents/route.ts";
import * as documentRoute from "../../src/app/api/tenants/[tenantId]/documents/[documentId]/route.ts";
import * as downloadRoute from "../../src/app/api/tenants/[tenantId]/documents/[documentId]/download/route.ts";
import * as docReviewRoute from "../../src/app/api/tenants/[tenantId]/documents/[documentId]/review/route.ts";
import * as reprocessRoute from "../../src/app/api/tenants/[tenantId]/documents/[documentId]/reprocess/route.ts";
import * as batchRoute from "../../src/app/api/tenants/[tenantId]/batches/[batchId]/route.ts";
import * as entriesRoute from "../../src/app/api/tenants/[tenantId]/entries/route.ts";
import * as entryRoute from "../../src/app/api/tenants/[tenantId]/entries/[entryId]/route.ts";
import * as actionsRoute from "../../src/app/api/tenants/[tenantId]/entries/[entryId]/actions/route.ts";
import * as issuesRoute from "../../src/app/api/tenants/[tenantId]/issues/route.ts";
import * as respondRoute from "../../src/app/api/tenants/[tenantId]/issues/[issueId]/respond/route.ts";
import * as validateRoute from "../../src/app/api/tenants/[tenantId]/issues/[issueId]/validate/route.ts";
import { createTestDb, insert, seed, type Seed, type TestDb } from "./helpers.ts";

const ORIGIN = "http://app.test";
type Handler = (r: Request, s?: { params: Promise<Record<string, string>> }) => Promise<Response>;

const objects = new Map<string, Buffer>();
let storageDown = false;
const storage: FileStorage = {
  bucket: "documents",
  async put(key, bytes) { if (objects.has(key)) throw new Error("exists"); objects.set(key, bytes); },
  async get(key) { if (storageDown) throw new Error("indisponível"); return objects.get(key)!; },
  async signedUrl(key) { return `https://signed.test/${key}`; },
  async remove(key) { objects.delete(key); },
};

type Tx = [day: string, amount: string, fitid: string, memo?: string];
const ofx = (start: string, end: string, txs: Tx[]) => `OFXHEADER:100
DATA:OFXSGML
CHARSET:1252

<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>BRL
<BANKTRANLIST><DTSTART>202611${start}<DTEND>202611${end}
${txs.map(([d, a, id, memo]) => `<STMTTRN>
<TRNTYPE>OTHER
<DTPOSTED>202611${d}120000[-3:BRT]
<TRNAMT>${a}
<FITID>${id}
<MEMO>${memo ?? "PIX " + id}
</STMTTRN>`).join("\n")}
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;

describe("coleta, importação, lançamentos e pendências", () => {
  let db: TestDb;
  let s: Seed;
  let employee = "", owner = "", cash = "", employeeMembership = "";

  async function call(handler: Handler, user: string, options: {
    method?: string; params?: Record<string, string>; body?: unknown; form?: FormData; query?: string;
  } = {}) {
    const response = await handler(
      new Request(`${ORIGIN}/api${options.query ?? ""}`, {
        method: options.method ?? (options.body !== undefined || options.form ? "POST" : "GET"),
        headers: { origin: ORIGIN, "x-user": user },
        body: options.form ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
      }),
      { params: Promise.resolve({ tenantId: s.a.id, ...options.params }) });
    return { status: response.status, body: await response.json() };
  }

  async function upload(user: string, name: string, content: string | Buffer, data: object) {
    const form = new FormData();
    form.set("file", new File([new Uint8Array(Buffer.from(content))], name));
    form.set("data", JSON.stringify(data));
    return call(documentsRoute.POST, user, { form });
  }
  const statement = async (name: string, content: string, extra: object = {}, account?: string) => {
    const r = await upload(s.user, name, content, { docCategory: "BANK_STATEMENT", financialAccountId: account ?? s.a.bankA, ...extra });
    expect(r.status).toBe(201);
    while (await processNext(db.app, storage));
    return r.body as { id: string; batchId: string };
  };
  const batch = async (id: string) => (await call(batchRoute.GET, s.user, { params: { batchId: id } })).body;
  const count = async (sql: string, values: unknown[] = []) =>
    (await db.admin.query(`SELECT count(*)::int AS n FROM ${sql}`, values)).rows[0].n as number;

  beforeAll(async () => {
    db = await createTestDb();
    s = await seed(db);
    setDeps({
      pool: db.app, appUrl: ORIGIN, storage,
      verifySession: async (r) => ({ userId: r.headers.get("x-user")!, aal: "aal2", hasVerifiedFactor: false }),
      identity: { async invite() { throw new Error("n/a"); }, async remove() {} },
    });
    const c = await db.admin.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.current_user_id',$1,true), set_config('app.actor_role','SYSTEM_WORKER',true)", [s.user]);
      for (const [user_id, bpo_role] of [[s.user, "BPO_ANALYST"], [s.reviewer, "BPO_REVIEWER"]]) {
        await insert(c, "bpo_staff_assignments", { user_id, tenant_id: s.a.id, bpo_role });
      }
      owner = await insert(c, "users", { email: "dono@a.local", full_name: "Dono" });
      employee = await insert(c, "users", { email: "func@a.local", full_name: "Func" });
      await insert(c, "tenant_memberships", { tenant_id: s.a.id, user_id: owner, client_role: "CLIENT_MASTER", is_blind_mode: false });
      employeeMembership = await insert(c, "tenant_memberships",
        { tenant_id: s.a.id, user_id: employee, client_role: "CLIENT_EMPLOYEE" });
      cash = await insert(c, "financial_accounts", { tenant_id: s.a.id, business_unit_id: s.a.unit, name: "Caixa",
        account_type: "CASH_PHYSICAL", initial_balance_date: "2026-11-01" });
      await insert(c, "user_scopes", { tenant_id: s.a.id, membership_id: employeeMembership, business_unit_id: s.a.unit,
        can_create_manual_entries: true, allowed_entry_types: "{CASH_EXPENSE}", max_entry_amount: "500.00" });
      await insert(c, "client_settings", { tenant_id: s.a.id, setting_key: "MANUAL_RECEIPT_THRESHOLD",
        setting_value: '"100.00"', effective_from: "2026-01-01", version: 1, updated_by_user_id: s.user });
      await c.query("COMMIT");
    } finally {
      c.release();
    }
  });
  afterAll(async () => { setDeps(undefined); await db.close(); });

  const first: Tx[] = [["02", "100.00", "F1"], ["10", "-40.50", "F2"], ["15", "10.00", "F3"]];

  it("Cenário 2: mesmo arquivo não duplica e período maior importa só o novo", async () => {
    const one = await statement("nov-1.ofx", ofx("01", "15", first));
    expect(await batch(one.batchId)).toMatchObject({ status: "IMPORTED_COMPLETE", imported_items: 3 });

    const again = await statement("outro-nome.ofx", ofx("01", "15", first));
    expect(await batch(again.batchId)).toMatchObject({ status: "DUPLICATE_FILE", total_items: 0 });

    const wider = await statement("nov-2.ofx", ofx("01", "30", [...first, ["20", "55.00", "F4"], ["28", "-5.00", "F5"]]));
    expect(await batch(wider.batchId)).toMatchObject(
      { status: "IMPORTED_COMPLETE", total_items: 5, imported_items: 2, duplicate_items: 3 });
    expect(await count("bank_transactions WHERE financial_account_id=$1", [s.a.bankA])).toBe(5);
    expect(await count("audit_logs WHERE entity_type='bank_transactions' AND actor_effective_role='SYSTEM_WORKER' AND source='JOB'")).toBe(5);
  });

  const csv = (lines: string[]) => ["Data;Valor;Historico", ...lines].join("\n");
  const mapping = { bank_posting_date: "Data", amount: "Valor", description: "Historico" };

  it("sobreposição sem ID forte aguarda decisão humana antes de efetivar", async () => {
    const n = () => count("bank_transactions WHERE financial_account_id=$1", [s.a.bankB]);
    await statement("a.csv", csv(["03/11/2026;-1.234,56;Aluguel", "04/11/2026;50,00;Venda", "04/11/2026;50,00;Venda"]), { mapping }, s.a.bankB);
    expect(await n()).toBe(3); // duas linhas iguais no mesmo dia são dois movimentos

    const second = await statement("b.csv", csv(["04/11/2026;50,00;VENDA", "09/11/2026;7,00;Tarifa"]), { mapping }, s.a.bankB);
    const b = await batch(second.batchId);
    expect(b.status).toBe("OVERLAP_REVIEW");
    expect(b.items.map((i: { item_status: string }) => i.item_status)).toEqual(["AMBIGUOUS_OVERLAP", "NEW_VALID"]);
    expect(await n()).toBe(3);

    const decide = (decision: string) => call(batchRoute.POST, s.user, { params: { batchId: second.batchId },
      body: { decisions: [{ itemId: b.items[0].id, decision, reason: "conferido no banco" }] } });
    const done = await decide("COMMIT");
    expect(done.body).toMatchObject({ status: "IMPORTED_COMPLETE", imported_items: 2 });
    expect(await n()).toBe(5);
    expect((await decide("COMMIT")).status).toBe(409);
  });

  it("saldo que não confere abre pendência CRITICAL no lote", async () => {
    const r = await statement("saldo.ofx", ofx("16", "17", [["16", "10.00", "S1"]]), { openingBalance: "0.00", closingBalance: "99.00" });
    expect((await batch(r.batchId)).status).toBe("IMPORTED_WITH_EXCEPTIONS");
    expect(await count("blocking_issues WHERE target_entity_id=$1 AND severity='CRITICAL' AND status='WAITING_BPO_ACTION'", [r.batchId])).toBe(1);
  });

  it("arquivo inválido é rejeitado sem armazenar; corrompido falha preservando o original", async () => {
    const before = objects.size;
    const bad = await upload(owner, "virus.exe", "MZ", { docCategory: "OTHER" });
    expect(bad.body).toMatchObject({ receiptStatus: "REJECTED_INVALID", rejectionReason: "UNSUPPORTED_TYPE" });
    expect((await upload(owner, "x.pdf", "", { docCategory: "OTHER" })).body.rejectionReason).toBe("EMPTY_FILE");
    expect(objects.size).toBe(before);

    const broken = await statement("q.csv", "coluna\nvalor");
    const d = await call(documentRoute.GET, s.user, { params: { documentId: broken.id } });
    expect(d.body).toMatchObject({ processing_status: "FAILED_PROCESSING", processing_error: "MISSING_COLUMNS", batch_status: "REJECTED" });
    expect(objects.size).toBe(before + 1);
    expect((await call(reprocessRoute.POST, s.user, { method: "POST", params: { documentId: broken.id } })).status).toBe(201);
    while (await processNext(db.app, storage));
  });

  it("falha transitória tem tentativas limitadas e depois pode ser reprocessada", async () => {
    storageDown = true;
    const r = await statement("t.ofx", ofx("18", "18", [["18", "1.00", "T1"]]));
    for (let i = 0; i < 2; i++) {
      await db.admin.query("UPDATE app.processing_queue SET next_attempt_at = now()");
      while (await processNext(db.app, storage));
    }
    expect((await batch(r.batchId)).status).toBe("FAILED_IMPORT");
    storageDown = false;
    await call(reprocessRoute.POST, s.user, { method: "POST", params: { documentId: r.id } });
    while (await processNext(db.app, storage));
    expect((await batch(r.batchId)).status).toBe("IMPORTED_COMPLETE");
  });

  it("relatório de adquirente valida a soma e não gera movimentação bancária", async () => {
    const header = "external_nsu_tid;operation_date;gross_amount;mdr_fee_amount;net_amount;event_type";
    const before = await count("bank_transactions");
    const r = await upload(s.user, "adq.csv", [header, "N1;2026-11-05;100,00;2,00;98,00;SALE",
      "N2;2026-11-05;100,00;2,00;90,00;SALE", "N1;2026-11-05;100,00;2,00;98,00;SALE"].join("\n"),
      { docCategory: "ACQUIRER_REPORT", acquirerId: s.a.acquirer });
    while (await processNext(db.app, storage));
    const b = await batch(r.body.batchId);
    expect(b.status).toBe("READY_TO_IMPORT");
    expect(b.items.map((i: { item_status: string }) => i.item_status)).toEqual(["NEW_VALID", "INVALID_ITEM", "DUPLICATE_ITEM"]);
    expect(await count("bank_transactions")).toBe(before);
  });

  it("documentos: outro tenant negado, funcionário vê só os seus e não importa extrato; triagem", async () => {
    const mine = await upload(employee, "foto.pdf", "%PDF-1.4 recibo", { docCategory: "RECEIPT", businessUnitId: s.a.unit });
    expect(mine.body).toMatchObject({ receiptStatus: "RECEIVED", processingStatus: "NOT_STARTED" });
    const asStatement = await upload(employee, "e.ofx", ofx("19", "19", [["19", "9.00", "E1"]]),
      { docCategory: "BANK_STATEMENT", businessUnitId: s.a.unit, financialAccountId: cash });
    expect(asStatement.body.batchId).toBeNull();
    expect((await upload(employee, "f.pdf", "%PDF-1.4 x", { docCategory: "RECEIPT" })).status).toBe(403); // fora do escopo

    const list = await call(documentsRoute.GET, employee);
    expect(list.body).toHaveLength(2);
    const other = (await call(documentsRoute.GET, s.user)).body.find((d: { uploaded_by_user_id: string }) => d.uploaded_by_user_id !== employee);
    expect((await call(downloadRoute.GET, employee, { params: { documentId: other.id } })).status).toBe(403);
    expect((await call(downloadRoute.GET, employee, { params: { documentId: mine.body.id } })).body.url).toContain("signed");
    expect((await call(documentsRoute.GET, employee, { params: { tenantId: s.b.id } })).status).toBe(403);

    const review = (action: string, user = s.user) =>
      call(docReviewRoute.POST, user, { params: { documentId: mine.body.id }, body: { action } });
    expect((await review("START", employee)).status).toBe(403);
    expect((await review("APPROVE")).status).toBe(409);
    expect((await review("START")).status).toBe(201);
    expect((await review("APPROVE")).status).toBe(201);
  });

  const expense = (amount: string, extra: object = {}) =>
    ({ entryType: "CASH_EXPENSE", financialAccountId: cash, date: "2026-11-20", amount, description: "Compra de gelo", ...extra });

  it("lançamento manual: aguarda conferência, respeita o escopo e exige comprovante acima do limite", async () => {
    const create = (body: object, user = employee) => call(entriesRoute.POST, user, { body });
    expect((await create(expense("600.00", { missingReceiptJustification: "sem nota fiscal" }))).status).toBe(403);
    expect((await create(expense("50.00", { entryType: "DECLARED_RECEIPT" }))).status).toBe(403);
    expect((await create(expense("50.00", { financialAccountId: s.a.bankA, businessUnitId: s.a.unit }))).body.error).toBe("CASH_ACCOUNT_REQUIRED");
    expect((await create(expense("200.00"))).body.error).toBe("RECEIPT_OR_JUSTIFICATION_REQUIRED");

    const ok = await create(expense("200.00", { missingReceiptJustification: "fornecedor não emitiu" }));
    expect(ok.body.reviewStatus).toBe("SUBMITTED_PENDING_BPO");
    expect(await count("blocking_issues WHERE target_entity_id=$1 AND severity='WARNING'", [ok.body.id])).toBe(1);

    const params = { entryId: ok.body.id };
    const patch = () => call(entryRoute.PATCH, employee, { method: "PATCH", params, body: { amount: "90.00" } });
    expect((await patch()).status).toBe(403); // enviado: funcionário não edita
    const act = (user: string, action: string, note?: string) => call(actionsRoute.POST, user, { params, body: { action, note } });
    expect((await act(s.user, "START")).status).toBe(201);
    expect((await act(s.user, "APPROVE")).status).toBe(403); // analista não aprova
    expect((await act(owner, "APPROVE")).status).toBe(403);
    expect((await act(s.reviewer, "RETURN", "valor divergente")).status).toBe(201);
    expect((await patch()).status).toBe(200);
    expect((await act(employee, "SUBMIT")).body.reviewStatus).toBe("SUBMITTED_PENDING_BPO");
    await act(s.user, "START");
    expect((await act(s.reviewer, "APPROVE")).body.reviewStatus).toBe("APPROVED_FOR_LEDGER");
    expect((await call(entryRoute.DELETE, owner, { method: "DELETE", params })).status).toBe(403);

    const draft = await create(expense("10.00", { asDraft: true }));
    expect((await call(entryRoute.DELETE, employee, { method: "DELETE", params: { entryId: draft.body.id } })).status).toBe(200);
    expect(await count("cash_transactions WHERE id=$1 AND deleted_at IS NOT NULL", [draft.body.id])).toBe(1);
  });

  it("Cenário 9: resposta não encerra a pendência; só a validação do revisor", async () => {
    const tx = (await db.admin.query("SELECT id FROM bank_transactions WHERE direction='DEBIT' LIMIT 1")).rows[0].id;
    const body = { competenceDate: "2026-11-20", targetType: "BANK_TRANSACTION", targetId: tx, severity: "BLOCKING_OPERATIONAL",
      title: "Saída sem comprovante", description: "Envie o comprovante", assignedToSide: "CLIENT", assignedToUserId: employee };
    expect((await call(issuesRoute.POST, owner, { body })).status).toBe(403);
    const id = (await call(issuesRoute.POST, s.user, { body })).body.id;
    const hidden = (await call(issuesRoute.POST, s.user, { body: { ...body, assignedToUserId: undefined } })).body.id;

    expect((await call(issuesRoute.GET, employee)).body.map((i: { id: string }) => i.id)).toEqual([id]);
    const respond = (issueId: string, user = employee, documentId?: string) =>
      call(respondRoute.POST, user, { params: { issueId }, body: { text: "segue comprovante", documentId } });
    expect((await respond(hidden)).status).toBe(403);

    const receipt = await upload(employee, "c.pdf", "%PDF-1.4 comprovante", { docCategory: "RECEIPT", businessUnitId: s.a.unit });
    expect((await respond(id, employee, receipt.body.id)).body.status).toBe("ANSWERED_PENDING_BPO_VALIDATION");
    const validate = (user: string, decision: string) =>
      call(validateRoute.POST, user, { params: { issueId: id }, body: { decision, reason: "conferido" } });
    expect((await validate(s.user, "ACCEPT")).status).toBe(403); // escolha E4
    expect((await validate(s.reviewer, "REJECT")).body.status).toBe("WAITING_CLIENT_RESPONSE");
    await respond(id, owner);
    expect((await validate(s.reviewer, "ACCEPT")).body.status).toBe("RESOLVED");
  });
});

describe("parsers", () => {
  it("XLSX, OFX corrompido e valores ambíguos", async () => {
    const p = await import("../../src/modules/import-processing/parsers.ts");
    expect(p.parseAmount("1.234,5")).toBe("1234.50");
    expect(p.parseAmount("0.30000000000000004")).toBe("0.30");
    expect(p.parseAmount("1.234")).toBeNull();
    expect(p.parseAmount("1,234.00")).toBeNull();
    expect(p.parseDate("31/02/2026")).toBeNull();
    expect(() => p.parseOfx(Buffer.from("<OFX><STMTTRN>"))).toThrow("CORRUPTED_FILE");
    await expect(p.parseBankStatement(Buffer.from("PK\u0003\u0004lixo"), "xlsx")).rejects.toThrow("CORRUPTED_FILE");
  });
});

describe("planilha real", () => {
  it("lê datas e valores exatos", async () => {
    const { readFileSync } = await import("node:fs");
    const { parseBankStatement } = await import("../../src/modules/import-processing/parsers.ts");
    const r = await parseBankStatement(readFileSync("db/tests/fixtures/extrato.xlsx"), "xlsx");
    expect(r.rows.map((x) => [x.date, x.direction, x.amount])).toEqual(
      [["2026-11-05", "DEBIT", "1234.56"], ["2026-11-06", "CREDIT", "10.00"]]);
  });
});
