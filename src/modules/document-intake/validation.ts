/** Validação na entrada (Doc 1, Exceção 2). Não substitui antivírus. */
/** Abaixo do teto de 4,5 MB por requisição das funções da Vercel. */
export const MAX_FILE_BYTES = 4 * 1024 * 1024;

const startsWith = (b: Buffer, ...bytes: number[]) => bytes.every((v, i) => b[i] === v);
const isText = (b: Buffer) => !b.subarray(0, 8192).includes(0);

const TYPES: Record<string, { mime: string; matches(b: Buffer): boolean }> = {
  pdf: { mime: "application/pdf", matches: (b) => b.subarray(0, 5).toString() === "%PDF-" },
  png: { mime: "image/png", matches: (b) => startsWith(b, 0x89, 0x50, 0x4e, 0x47) },
  jpg: { mime: "image/jpeg", matches: (b) => startsWith(b, 0xff, 0xd8, 0xff) },
  jpeg: { mime: "image/jpeg", matches: (b) => startsWith(b, 0xff, 0xd8, 0xff) },
  xlsx: { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    matches: (b) => startsWith(b, 0x50, 0x4b, 0x03, 0x04) },
  ofx: { mime: "application/x-ofx", matches: (b) => isText(b) && /<OFX>/i.test(b.toString("latin1")) },
  csv: { mime: "text/csv", matches: isText },
  xml: { mime: "application/xml", matches: (b) => isText(b) && b.toString("utf8", 0, 200).trimStart().startsWith("<") },
};

export type FileCheck = { ok: true; extension: string; mimeType: string } | { ok: false; reason: string };

export function checkFile(name: string, bytes: Buffer): FileCheck {
  if (bytes.length === 0) return { ok: false, reason: "EMPTY_FILE" };
  const extension = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? "";
  const type = Object.hasOwn(TYPES, extension) ? TYPES[extension] : undefined;
  if (!type) return { ok: false, reason: "UNSUPPORTED_TYPE" };
  if (!type.matches(bytes)) return { ok: false, reason: "CONTENT_DOES_NOT_MATCH_TYPE" };
  return { ok: true, extension, mimeType: type.mime };
}

export const safeName = (name: string) =>
  (name.split(/[\\/]/).pop() ?? "").replace(/[\u0000-\u001f\u007f"]/g, "").slice(-200) || "arquivo";
