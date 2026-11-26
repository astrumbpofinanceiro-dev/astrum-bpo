import { after } from "next/server";
import { getDeps } from "../../../../../server/container";
import { processPending } from "../../../../../modules/import-processing/worker";
import { query, route } from "../../../../../server/http";
import { listDocuments, MAX_FILE_BYTES, uploadDocument } from "../../../../../modules/document-intake/index";
import { inTenant } from "../../../../../modules/identity-access/tenant-access";
import { AppError, invalid } from "../../../../../shared/errors";

export const GET = route(async ({ principal, deps, params, request }) =>
  inTenant(deps.pool, principal, params.tenantId!, { permission: "documents.view" },
    (c, a) => listDocuments(c, a, { reviewStatus: query(request, "reviewStatus") })));

/** multipart/form-data: "file" e "data" (JSON). */
export const POST = route(async ({ principal, deps, params, request }) => {
  if (Number(request.headers.get("content-length") ?? 0) > MAX_FILE_BYTES + 100_000) throw new AppError(413, "FILE_TOO_LARGE");
  let file: File, data: unknown;
  try {
    const form = await request.formData();
    const f = form.get("file");
    if (!(f instanceof File)) throw new Error();
    file = f;
    data = JSON.parse(String(form.get("data")));
  } catch {
    throw invalid("INVALID_FORM");
  }
  const result = await uploadDocument(deps.pool, deps.storage, principal, params.tenantId!,
    { name: file.name, bytes: Buffer.from(await file.arrayBuffer()) }, data);
  // Sem processo contínuo (Vercel): processa depois de responder; a rota agendada cobre o que sobrar.
  if (process.env.PROCESS_INLINE === "true") {
    after(async () => { const d = await getDeps(); await processPending(d.pool, d.storage); });
  }
  return result;
});

export const maxDuration = 60;
