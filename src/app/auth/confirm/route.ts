import { redirect } from "next/navigation";
import { supabaseServer } from "../../../server/supabase/server-client";

/** Destino dos links de convite e de recuperação enviados por e-mail. */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const tokenHash = params.get("token_hash");
  const type = params.get("type");
  if (tokenHash && (type === "invite" || type === "recovery")) {
    const supabase = await supabaseServer();
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
    if (!error) redirect("/definir-senha");
  }
  redirect("/login?erro=link");
}
