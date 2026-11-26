/** Worker de processamento. Pode haver várias instâncias. Uso: npm run worker */
import { processNext } from "../src/modules/import-processing/worker";
import { supabaseStorage } from "../src/server/supabase/storage";
import { getPool } from "../src/shared/db/pool";
import { assertUnprivilegedRole } from "../src/shared/db/tenant-context";

const pool = getPool();
await assertUnprivilegedRole(pool);
const storage = supabaseStorage();
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => (stopping = true));

while (!stopping) {
  try {
    if (!(await processNext(pool, storage))) await new Promise((r) => setTimeout(r, 3000));
  } catch (error) {
    console.error(error);
    await new Promise((r) => setTimeout(r, 10_000));
  }
}
await pool.end();
