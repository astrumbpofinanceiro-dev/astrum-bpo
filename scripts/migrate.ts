/** Aplica db/migrations em ordem, uma transação por arquivo, com checksum. */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";

export async function migrate(connectionString: string, dir = path.resolve("db/migrations")): Promise<string[]> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('bpo_migrations'))");
    await client.query(`CREATE SCHEMA IF NOT EXISTS migrations;
      CREATE TABLE IF NOT EXISTS migrations.history (
        name text PRIMARY KEY, checksum char(64) NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
    for (const name of files) {
      const sql = await readFile(path.join(dir, name), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const found = await client.query<{ checksum: string }>(
        "SELECT checksum FROM migrations.history WHERE name = $1", [name]);
      if (found.rows[0]) {
        if (found.rows[0].checksum !== checksum) throw new Error(`Migration já aplicada foi alterada: ${name}`);
        continue;
      }
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO migrations.history (name, checksum) VALUES ($1, $2)", [name, checksum]);
        await client.query("COMMIT");
        applied.push(name);
      } catch (error) {
        await client.query("ROLLBACK");
        throw new Error(`Falha em ${name}: ${(error as Error).message}`, { cause: error });
      }
    }
  } finally {
    await client.end();
  }
  return applied;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = process.env.DATABASE_MIGRATION_URL;
  if (!url) throw new Error("Defina DATABASE_MIGRATION_URL");
  const applied = await migrate(url);
  console.log(applied.length ? `Aplicadas:\n${applied.join("\n")}` : "Banco já atualizado.");
}
