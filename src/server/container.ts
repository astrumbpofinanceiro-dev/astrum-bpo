import type pg from "pg";
import type { FileStorage } from "../modules/document-intake/storage";
import type { IdentityProvider } from "../modules/identity-access/identity-provider";
import type { VerifiedSession } from "../modules/identity-access/principal";
import { env } from "../shared/config/env";
import { getPool } from "../shared/db/pool";
import { assertUnprivilegedRole } from "../shared/db/tenant-context";
import { supabaseIdentityProvider, verifySupabaseSession } from "./supabase/auth";
import { supabaseStorage } from "./supabase/storage";

export interface Deps {
  pool: pg.Pool;
  appUrl: string;
  verifySession(request: Request): Promise<VerifiedSession | null>;
  identity: IdentityProvider;
  storage: FileStorage;
}

let override: Deps | undefined;
let ready: Promise<Deps> | undefined;

/** Somente testes. */
export function setDeps(deps: Deps | undefined) {
  override = deps;
}

export function getDeps(): Promise<Deps> {
  if (override) return Promise.resolve(override);
  ready ??= (async () => {
    const pool = getPool();
    await assertUnprivilegedRole(pool); // recusa credencial que ignore RLS
    return { pool, appUrl: env().APP_URL, verifySession: verifySupabaseSession, identity: supabaseIdentityProvider(), storage: supabaseStorage() };
  })().catch((error) => {
    ready = undefined;
    throw error;
  });
  return ready;
}
