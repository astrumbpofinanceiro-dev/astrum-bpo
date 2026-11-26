/** Porta para o provedor de identidade (Supabase Auth em produção, falso nos testes). */
export interface IdentityProvider {
  /** Envia convite e devolve o id, que também será users.id. Lança AppError 409 se o e-mail já existir. */
  invite(email: string, fullName: string): Promise<string>;
  /** Compensação quando o cadastro local falha. */
  remove(userId: string): Promise<void>;
}
