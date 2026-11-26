/** Chamada pelo agendador da Vercel. Autenticação por segredo, sem sessão de usuário. */
import { createHash, timingSafeEqual } from "node:crypto";
import { processPending } from "../../../../modules/import-processing/worker";
import { getDeps } from "../../../../server/container";

export const maxDuration = 60;

const digest = (v: string) => createHash("sha256").update(v).digest();

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  const given = request.headers.get("authorization") ?? "";
  if (!secret || secret.length < 16 || !timingSafeEqual(digest(given), digest(`Bearer ${secret}`))) {
    return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }
  const { pool, storage } = await getDeps();
  return Response.json({ processed: await processPending(pool, storage) });
}
