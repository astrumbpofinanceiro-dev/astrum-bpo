# Etapa 2 — Identidade, multi-tenant e permissões

## Entregue
- Supabase Auth: login, convite, recuperação de senha, MFA TOTP (AAL2) validado no servidor.
- Isolamento: toda operação de cliente passa por `inTenant` (vínculo → permissão → contexto de RLS).
- Quatro níveis de usuário, carteira da equipe BPO, escopos por unidade/conta, Modo Cego.
- Sessão de suporte do Master com motivo, início, fim e ações marcadas.
- Configurações com vigência e versão. Cadastro de empresas, unidades, contas e adquirentes.
- Negativas de acesso gravadas em `audit_logs`; resposta 403 sem revelar se o registro existe.
- Telas apenas de acesso. Gestão é por API; os portais são da Etapa 5.

## Correção sobre a Etapa 1 (migration 0012)
Os papéis da Data API do Supabase (`anon`, `authenticated`, `service_role`) podiam herdar privilégios em
`public`, e `users` não tinha RLS. A 0012 revoga esses privilégios e protege `users`.
**Nunca usar um banco com 0001–0011 sem a 0012.**

## Verificação
Testes em PostgreSQL 16 com os papéis do Supabase simulados; typecheck; build; servidor iniciado localmente;
atualização de um banco da Etapa 1; `npm audit` sem vulnerabilidades.
**Não testado contra um projeto Supabase real:** login, convite, e-mails, MFA e conexão pelo pooler.
Do Cenário 1 do Doc 3, estão cobertos o isolamento, o escopo e o Modo Cego sobre lançamentos e saldo
inicial; saldo corrente só existe a partir da Etapa 4.

## Configurar o projeto Supabase
1. Authentication > Sign In: **desativar cadastro público** (só convite).
2. MFA TOTP habilitado. Senha mínima de 12 caracteres.
3. URL Configuration: Site URL = `APP_URL`.
4. Modelos de e-mail:
   - Convite: `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=invite`
   - Recuperação: `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=recovery`
5. Configurar SMTP próprio antes de produção.
6. API: **desativar a Data API** (a aplicação não a usa; é uma segunda barreira).
7. `npm run db:migrate` com a conexão do usuário `postgres`.
8. No SQL Editor: `CREATE ROLE bpo_app_login LOGIN PASSWORD '<senha forte>' IN ROLE bpo_app;`
9. `DATABASE_URL` pelo pooler (modo transação), usuário `bpo_app_login.<project-ref>`, com `DATABASE_CA_CERT`.
10. Primeiro Master: criar o usuário em Authentication, copiar o UID e executar, via `psql` (não pelo SQL Editor),
    `scripts/bootstrap-master.sql` com `-v uid=<UID> -v email=<e-mail> -v nome=<nome>` (comando no cabeçalho do arquivo).

Supabase não fornece códigos de recuperação de MFA: quem perder o aparelho precisa que um administrador
remova o fator no painel.

## Escolhas feitas que precisam da sua aprovação
| # | Escolha aplicada |
|---|---|
| E1 | MFA obrigatório para equipe BPO e Master Cliente; opcional para funcionário |
| E2 | Sessão de suporte dura 60 min, motivo com 10+ caracteres; vale para ler e para administrar o cliente |
| E3 | Limites do Master Cliente na configuração `CLIENT_GRANT_LIMITS`. Sem ela, ele não concede relatórios ou saldos, nem desliga o Modo Cego |
| E4 | Validar resposta de pendência: só Revisor e Master (matriz do Doc 1). A v3.1 §12 e o Cenário 9 citam também o Analista |
| E5 | Ajustes e estornos: Revisor e Master (o Doc 1 não define) |
| E6 | Somente o Master altera configurações, estrutura e carteira |
| E7 | Funcionário e Master Cliente editam só o que criaram; funcionário sem Modo Cego continua vendo só os próprios lançamentos |
| E8 | `user_scopes` pode ser apagado na substituição; o valor antigo fica na auditoria |
| E9 | Configuração não aceita vigência anterior à da versão mais recente |
| E10 | Chaves novas de configuração: `CLIENT_GRANT_LIMITS` e `CLIENT_MANUAL_ENTRY_ENABLED` (esta só passa a valer na Etapa 3) |

## Bloqueiam a Etapa 3
**P1. Pendência sem destinatário.** `blocking_issues` só indica o lado (cliente ou BPO). Por isso o funcionário
hoje não responde nenhuma. Proposta: coluna `assigned_to_user_id`.
**P2. Tipo de lançamento.** O escopo limita `allowed_entry_types`, mas os lançamentos não têm essa coluna.
Proposta: `entry_type` em `economic_operations` e `cash_transactions`.
**P3. Layouts concretos** (antiga D6): arquivos de exemplo anonimizados de bancos e adquirentes.
