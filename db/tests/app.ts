/** Aplicação de teste: rotas e worker reais sobre um banco descartável. */
import { expect } from "vitest";
import { setDeps } from "../../src/server/container.ts";
import { processNext } from "../../src/modules/import-processing/worker.ts";
import type { FileStorage } from "../../src/modules/document-intake/storage.ts";
import * as documents from "../../src/app/api/tenants/[tenantId]/documents/route.ts";
import { createTestDb, insert, seed, type Seed, type TestDb } from "./helpers.ts";

export type Handler = (r: Request, s?: { params: Promise<Record<string, string>> }) => Promise<Response>;
type Options = { method?: string; params?: Record<string, string>; body?: unknown; form?: FormData; query?: string; tenant?: string };

export type Tx = [date: string, amount: string, fitid: string];
const ymd = (d: string) => d.replaceAll("-", "");
export const ofx = (start: string, end: string, txs: Tx[]) => `OFXHEADER:100
DATA:OFXSGML
CHARSET:1252

<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>BRL
<BANKTRANLIST><DTSTART>${ymd(start)}<DTEND>${ymd(end)}
${txs.map(([d, a, id]) => `<STMTTRN>
<TRNTYPE>OTHER
<DTPOSTED>${ymd(d)}120000[-3:BRT]
<TRNAMT>${a}
<FITID>${id}
<MEMO>PIX ${id}
</STMTTRN>`).join("\n")}
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;

export async function testApp() {
  const db: TestDb = await createTestDb();
  const s: Seed = await seed(db);
  const objects = new Map<string, Buffer>();
  const storage: FileStorage = {
    bucket: "documents", async put(k, b) { objects.set(k, b); }, async get(k) { return objects.get(k)!; },
    async signedUrl() { return ""; }, async remove(k) { objects.delete(k); },
  };
  setDeps({
    pool: db.app, appUrl: "http://app.test", storage,
    verifySession: async (r) => ({ userId: r.headers.get("x-user")!, aal: "aal2", hasVerifiedFactor: false }),
    identity: { async invite() { throw new Error("n/a"); }, async remove() {} },
  });

  const ids = { analyst: s.user, reviewer: s.reviewer, owner: "", employee: "", unit2: "" };
  const c = await db.admin.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.current_user_id',$1,true), set_config('app.actor_role','SYSTEM_WORKER',true)", [s.user]);
    for (const [user_id, bpo_role] of [[s.user, "BPO_ANALYST"], [s.reviewer, "BPO_REVIEWER"]]) {
      await insert(c, "bpo_staff_assignments", { user_id, tenant_id: s.a.id, bpo_role });
    }
    ids.owner = await insert(c, "users", { email: "dono@a.local", full_name: "Dono A" });
    ids.employee = await insert(c, "users", { email: "func@a.local", full_name: "Funcionário X" });
    await insert(c, "tenant_memberships", { tenant_id: s.a.id, user_id: ids.owner, client_role: "CLIENT_MASTER", is_blind_mode: false });
    const membership = await insert(c, "tenant_memberships",
      { tenant_id: s.a.id, user_id: ids.employee, client_role: "CLIENT_EMPLOYEE", is_blind_mode: true });
    await insert(c, "user_scopes", { tenant_id: s.a.id, membership_id: membership, business_unit_id: s.a.unit, can_upload_documents: true });
    ids.unit2 = await insert(c, "business_units", { tenant_id: s.a.id, name: "Unidade 2" });
    await c.query("COMMIT");
  } finally {
    c.release();
  }

  async function call(handler: Handler, user: string, o: Options = {}) {
    const response = await handler(
      new Request(`http://app.test/api${o.query ?? ""}`, {
        method: o.method ?? (o.body !== undefined || o.form ? "POST" : "GET"),
        headers: { origin: "http://app.test", "x-user": user },
        body: o.form ?? (o.body === undefined ? undefined : JSON.stringify(o.body)),
      }), { params: Promise.resolve({ tenantId: o.tenant ?? s.a.id, ...o.params }) });
    return { status: response.status, body: await response.json().catch(() => null) };
  }
  async function ok(handler: Handler, user: string, o: Options = {}) {
    const r = await call(handler, user, o);
    expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
    return r.body;
  }
  async function upload(user: string, name: string, content: string, data: object) {
    const form = new FormData();
    form.set("file", new File([new Uint8Array(Buffer.from(content))], name));
    form.set("data", JSON.stringify(data));
    return ok(documents.POST, user, { form }) as Promise<{ id: string; batchId: string | null }>;
  }
  const work = async () => { while (await processNext(db.app, storage)); };
  const rows = async (sql: string, ...values: unknown[]) => (await db.admin.query(sql, values)).rows;

  /** Importa um extrato pela rota e pelo worker; devolve os IDs na ordem das linhas. */
  async function statement(txs: Tx[], account = s.a.bankA) {
    const dates = txs.map(([d]) => d).sort();
    await upload(s.user, `${txs[0]![2]}.ofx`, ofx(dates[0]!, dates.at(-1)!, txs),
      { docCategory: "BANK_STATEMENT", financialAccountId: account });
    await work();
    const found: string[] = [];
    for (const [, , fitid] of txs) {
      const [row] = await rows("SELECT id FROM bank_transactions WHERE external_fitid = $1 AND financial_account_id = $2", fitid, account);
      found.push(row.id);
    }
    return found;
  }

  return { db, s, ids, call, ok, upload, work, rows, statement, close: async () => { setDeps(undefined); await db.close(); } };
}
export type App = Awaited<ReturnType<typeof testApp>>;
