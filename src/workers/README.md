# Workers
Jobs assíncronos idempotentes (Etapa 3). Todo job carrega `tenantId` e acessa o
banco somente via `withContext` com `actorRole: "SYSTEM_WORKER"`.
`audit_logs.actor_user_id` é obrigatório: a Etapa 2 criará um usuário de sistema.
