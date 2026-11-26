import { createClient } from "@supabase/supabase-js";
import type { IdentityProvider } from "../../modules/identity-access/identity-provider";
import type { VerifiedSession } from "../../modules/identity-access/principal";
import { env } from "../../shared/config/env";
import { conflict } from "../../shared/errors";
import { supabaseServer } from "./server-client";

/**
 * getUser consulta o servidor de Auth (percebe logout/revogação) e valida o token;
 * só então o nível de garantia (aal) é lido dos claims do mesmo token.
 */
export async function verifySupabaseSession(): Promise<VerifiedSession | null> {
  const supabase = await supabaseServer();
  const { data: userData, error } = await supabase.auth.getUser();
  if (error || !userData.user) return null;
  const { data: claimsData } = await supabase.auth.getClaims();
  const claims = claimsData?.claims;
  if (!claims || claims.sub !== userData.user.id) return null;
  return {
    userId: userData.user.id,
    aal: claims.aal === "aal2" ? "aal2" : "aal1",
    hasVerifiedFactor: (userData.user.factors ?? []).some((f) => f.status === "verified"),
  };
}

export function supabaseIdentityProvider(): IdentityProvider {
  const admin = () => {
    const e = env();
    return createClient(e.NEXT_PUBLIC_SUPABASE_URL, e.SUPABASE_SECRET_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    }).auth.admin;
  };
  return {
    async invite(email, fullName) {
      const { data, error } = await admin().inviteUserByEmail(email, { data: { full_name: fullName } });
      if (error?.code === "email_exists" || error?.status === 422) throw conflict("USER_CANNOT_BE_INVITED");
      if (error || !data.user) throw new Error(`Falha no convite: ${error?.code ?? "sem usuário"}`);
      return data.user.id;
    },
    async remove(userId) {
      const { error } = await admin().deleteUser(userId);
      if (error) console.error("Conta órfã no provedor de identidade", { userId, code: error.code });
    },
  };
}
