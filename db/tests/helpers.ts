import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { migrate } from "../../scripts/migrate.ts";
import { withContext, type RequestContext } from "../../src/shared/db/tenant-context.ts";

pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

export type Row = Record<string, unknown>;

export interface TestDb {
  admin: pg.Pool;
  app: pg.Pool;
  close(): Promise<void>;
}

/** Cria um banco descartável, aplica as migrations e conecta como role sem privilégios. */
export async function createTestDb(): Promise<TestDb> {
  const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
  if (!adminUrl) throw new Error("Defina TEST_DATABASE_ADMIN_URL (servidor PostgreSQL descartável).");
  const suffix = randomBytes(4).toString("hex");
  const dbName = `bpo_test_${suffix}`;
  const login = `bpo_test_login_${suffix}`;
  const password = randomBytes(12).toString("hex");

  const root = new pg.Client({ connectionString: adminUrl });
  await root.connect();
  await root.query(`CREATE DATABASE ${dbName}`);
  const dbUrl = new URL(adminUrl);
  dbUrl.pathname = `/${dbName}`;
  // Reproduz o Supabase: papéis da Data API recebem privilégios por padrão em public.
  for (const r of ["anon", "authenticated", "service_role"]) {
    await root.query(`DO $$ BEGIN CREATE ROLE ${r} NOLOGIN; EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL; END $$`);
  }
  const pre = new pg.Client({ connectionString: dbUrl.toString() });
  await pre.connect();
  await pre.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
                   GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role`);
  await pre.end();
  await migrate(dbUrl.toString());
  await root.query(`CREATE ROLE ${login} LOGIN PASSWORD '${password}' IN ROLE bpo_app`);

  const appUrl = new URL(dbUrl);
  appUrl.username = login;
  appUrl.password = password;
  const admin = new pg.Pool({ connectionString: dbUrl.toString() });
  const app = new pg.Pool({ connectionString: appUrl.toString() });
  return {
    admin,
    app,
    async close() {
      await app.end();
      await admin.end();
      // Aguarda o servidor encerrar as sessões antes de remover o banco.
      for (let i = 0; i < 100; i++) {
        const { rowCount } = await root.query("SELECT 1 FROM pg_stat_activity WHERE datname = $1", [dbName]);
        if (!rowCount) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      await root.query(`DROP DATABASE ${dbName}`);
      await root.query(`DROP ROLE ${login}`);
      await root.end();
    },
  };
}

export async function insert(client: pg.ClientBase | pg.Pool, table: string, values: Row): Promise<string> {
  const keys = Object.keys(values);
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(",")}) RETURNING id`,
    Object.values(values),
  );
  return rows[0]!.id;
}

export function ctx(userId: string, tenantId: string | null, extra: Partial<RequestContext> = {}): RequestContext {
  return { userId, tenantId, actorRole: "BPO_ANALYST", source: "API", ...extra };
}

export interface Seed {
  user: string; reviewer: string; master: string;
  a: TenantSeed; b: TenantSeed;
}
export interface TenantSeed { id: string; unit: string; bankA: string; bankB: string; acquirer: string }

export async function seed(db: TestDb): Promise<Seed> {
  const user = randomUUID();
  const client = await db.admin.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.current_user_id',$1,true), set_config('app.actor_role','SYSTEM_WORKER',true)", [user]);
    await insert(client, "users", { id: user, email: "analista@teste.local", full_name: "Analista" });
    const reviewer = await insert(client, "users", { email: "revisor@teste.local", full_name: "Revisor" });
    const master = await insert(client, "users", { email: "master@teste.local", full_name: "Master", is_bpo_master: true });
    const tenant = async (name: string, taxId: string): Promise<TenantSeed> => {
      const id = await insert(client, "tenants", { legal_name: name, trade_name: name, tax_id: taxId, segment_code: "RETAIL" });
      const unit = await insert(client, "business_units", { tenant_id: id, name: "Unidade 1" });
      const account = (n: string) => insert(client, "financial_accounts",
        { tenant_id: id, name: n, account_type: "BANK_CHECKING", initial_balance_date: "2026-11-01" });
      const bankA = await account("Banco A");
      const bankB = await account("Banco B");
      const acquirer = await insert(client, "acquirers", { tenant_id: id, name: "Adquirente", settlement_account_id: bankA });
      return { id, unit, bankA, bankB, acquirer };
    };
    const a = await tenant("Cliente A", "00000000000001");
    const b = await tenant("Cliente B", "00000000000002");
    await client.query("COMMIT");
    return { user, reviewer, master, a, b };
  } finally {
    client.release();
  }
}

/** Executa como a aplicação, no tenant informado. */
export function as<T>(db: TestDb, c: RequestContext, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  return withContext(db.app, c, work);
}

export const bankTx = (t: TenantSeed, amount: string, extra: Row = {}): Row => ({
  tenant_id: t.id, financial_account_id: t.bankA, bank_posting_date: "2026-11-28",
  direction: "CREDIT", amount, description: "movimento", ...extra,
});

export const operation = (t: TenantSeed, userId: string, amount: string, extra: Row = {}): Row => ({
  tenant_id: t.id, operation_type: "SALE", origin_type: "BPO_ENTRY", created_by_user_id: userId,
  operation_date: "2026-11-25", competence_date: "2026-11-25", gross_amount: amount, description: "venda", ...extra,
});

export async function installment(c: pg.ClientBase, t: TenantSeed, userId: string, gross: string, fee = "0.00") {
  const op = await insert(c, "economic_operations", operation(t, userId, gross));
  const obligation = await insert(c, "financial_obligations",
    { tenant_id: t.id, economic_operation_id: op, direction: "RECEIVABLE", total_amount: gross, status: "OPEN" });
  const net = (await c.query<{ n: string }>("SELECT ($1::numeric - $2::numeric)::numeric(15,2) AS n", [gross, fee])).rows[0]!.n;
  const id = await insert(c, "obligation_installments", {
    tenant_id: t.id, obligation_id: obligation, installment_number: 1, total_installments: 1, gross_amount: gross,
    expected_fee_amount: fee, net_expected_amount: net, due_date: "2026-12-25",
    original_expected_settlement_date: "2026-12-25", current_expected_settlement_date: "2026-12-25", status: "OPEN",
  });
  return { op, obligation, id };
}
