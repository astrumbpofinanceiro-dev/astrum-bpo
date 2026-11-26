import { z } from "zod";
import { authenticate, type Principal } from "../modules/identity-access/principal";
import { AppError, forbidden, invalid, unauthenticated } from "../shared/errors";
import { getDeps, type Deps } from "./container";

type Params = Record<string, string>;

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });

export function toError(error: unknown): Response {
  if (error instanceof AppError) return json({ error: error.code }, error.status);
  if (error instanceof z.ZodError) {
    return json({ error: "VALIDATION", fields: error.issues.map((i) => i.path.join(".")) }, 400);
  }
  const code = (error as { code?: string }).code;
  if (code === "23505") return json({ error: "ALREADY_EXISTS" }, 409);
  if (code === "23503") return json({ error: "INVALID_REFERENCE" }, 400);
  if (code === "23514" || code === "P0001") {
    // Gatilhos do banco começam a mensagem com um código estável; os demais detalhes não saem.
    const rule = /^([A-Z_]{6,}):?/.exec((error as Error).message)?.[1];
    return json({ error: rule ?? "RULE_VIOLATION" }, 409);
  }
  if (code === "42501") return json({ error: "FORBIDDEN" }, 403);
  console.error(error);
  return json({ error: "INTERNAL" }, 500); // sem detalhes para o cliente
}

/** Autentica (com MFA quando exigido), confere a origem em escritas e padroniza erros. */
export function route(
  handler: (ctx: { principal: Principal; deps: Deps; params: Params; request: Request }) => Promise<unknown>,
) {
  return async (request: Request, segment?: { params: Promise<Params> }): Promise<Response> => {
    try {
      const deps = await getDeps();
      // CSRF: a sessão vem em cookie, então escrita só é aceita da própria origem.
      if (!["GET", "HEAD"].includes(request.method) &&
          request.headers.get("origin") !== new URL(deps.appUrl).origin) {
        throw forbidden();
      }
      const session = await deps.verifySession(request);
      if (!session) throw unauthenticated();
      const principal = await authenticate(deps.pool, session);
      const params = segment ? await segment.params : {};
      const result = await handler({ principal, deps, params, request });
      return json(result ?? { ok: true }, request.method === "POST" ? 201 : 200);
    } catch (error) {
      return toError(error);
    }
  };
}

export async function body(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw invalid("INVALID_JSON");
  }
}

export function query(request: Request, name: string): string | undefined {
  return new URL(request.url).searchParams.get(name) ?? undefined;
}

export function uuidParam(value: string | undefined): string {
  const parsed = z.guid().safeParse(value);
  if (!parsed.success) throw forbidden();
  return parsed.data;
}
