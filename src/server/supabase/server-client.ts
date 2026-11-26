import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { env } from "../../shared/config/env";

/** Um cliente por requisição; a sessão fica em cookies. */
export async function supabaseServer() {
  const { NEXT_PUBLIC_SUPABASE_URL: url, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: key } = env();
  const store = await cookies();
  return createServerClient(url, key, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => {
        try {
          for (const { name, value, options } of list) store.set(name, value, options);
        } catch {
          // Server Components não gravam cookies; o proxy.ts renova a sessão.
        }
      },
    },
  });
}
