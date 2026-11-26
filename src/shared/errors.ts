export class AppError extends Error {
  constructor(readonly status: 400 | 401 | 403 | 409 | 413, readonly code: string, message = code) {
    super(message);
  }
}
export const unauthenticated = () => new AppError(401, "UNAUTHENTICATED");
/** Mensagem única: não revela se o recurso existe (Doc 1, Exceção 1). */
export const forbidden = () => new AppError(403, "FORBIDDEN");
export const mfaRequired = () => new AppError(403, "MFA_REQUIRED");
export const conflict = (code: string) => new AppError(409, code);
export const invalid = (code: string) => new AppError(400, code);
