import pg from "pg";
import { env } from "../config/env";

// DATE é data de negócio: permanece "YYYY-MM-DD", sem conversão de fuso.
pg.types.setTypeParser(pg.types.builtins.DATE, (value) => value);
// NUMERIC já chega como string no node-postgres; nunca converter com Number().

let pool: pg.Pool | undefined;

export function getPool(): pg.Pool {
  const { DATABASE_URL, DATABASE_CA_CERT } = env();
  pool ??= new pg.Pool({
    connectionString: DATABASE_URL,
    // Cada instância serverless abre o próprio conjunto de conexões.
    max: Number(process.env.DATABASE_POOL_MAX ?? 5),
    ...(DATABASE_CA_CERT ? { ssl: { ca: DATABASE_CA_CERT.replace(/\\n/g, "\n") } } : {}),
  });
  return pool;
}
