import { z } from "zod";

const schema = z.object({
  APP_ENV: z.enum(["development", "test", "staging", "production"]),
  DATABASE_URL: z.url(),
  /** Certificado da CA do banco (PEM), exigido para TLS verificado com o Supabase. */
  DATABASE_CA_CERT: z.string().optional(),
  APP_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
  /** Somente no servidor: convida e remove usuários. */
  SUPABASE_SECRET_KEY: z.string().min(1),
  /** Bucket PRIVADO no Supabase Storage. */
  STORAGE_BUCKET: z.string().default("bpo-private"),
  SIGNED_URL_TTL_SECONDS: z.coerce.number().int().min(30).max(900).default(300),
});

export type Env = z.infer<typeof schema>;
let cached: Env | undefined;

/** Validação preguiçosa: falha no primeiro uso, não durante o build. */
export function env(): Env {
  cached ??= schema.parse(process.env);
  return cached;
}
