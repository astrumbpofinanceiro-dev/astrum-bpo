import { createBrowserClient } from "@supabase/ssr";

export function supabaseBrowser() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
  );
}

/** Aceita apenas caminho interno (evita redirecionamento aberto). */
export function safeNext(value: string | null | undefined): string {
  return value && /^\/(?![/\\])[A-Za-z0-9/_-]*$/.test(value) ? value : "/";
}
