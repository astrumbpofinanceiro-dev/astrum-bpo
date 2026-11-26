import { createClient } from "@supabase/supabase-js";
import type { FileStorage } from "../../modules/document-intake/storage";
import { env } from "../../shared/config/env";

export function supabaseStorage(): FileStorage {
  const e = env();
  const bucket = () => createClient(e.NEXT_PUBLIC_SUPABASE_URL, e.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  }).storage.from(e.STORAGE_BUCKET);
  const fail = (action: string, message: string) => new Error(`Storage (${action}): ${message}`);
  return {
    bucket: e.STORAGE_BUCKET,
    async put(key, bytes, mimeType) {
      const { error } = await bucket().upload(key, bytes, { contentType: mimeType, upsert: false });
      if (error) throw fail("upload", error.message);
    },
    async get(key) {
      const { data, error } = await bucket().download(key);
      if (error) throw fail("download", error.message);
      return Buffer.from(await data.arrayBuffer());
    },
    async signedUrl(key, downloadName) {
      const { data, error } = await bucket().createSignedUrl(key, e.SIGNED_URL_TTL_SECONDS, { download: downloadName });
      if (error) throw fail("assinatura", error.message);
      return data.signedUrl;
    },
    async remove(key) {
      const { error } = await bucket().remove([key]);
      if (error) console.error("Objeto órfão no storage", { key });
    },
  };
}
