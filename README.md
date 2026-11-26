# Plataforma de BPO Financeiro — MVP

Monólito modular (Next.js, React, TypeScript, PostgreSQL 15+ com RLS).
Estado atual: **Etapa 6** concluída (testes de aceite; ver `docs/etapa-6.md`). Detalhes por etapa em `docs/`. O processamento exige `npm run worker` em paralelo à aplicação.

## Estrutura
    db/migrations/        SQL versionado (não editar arquivo já aplicado; criar um novo)
    db/tests/             testes de banco em PostgreSQL real
    scripts/              runner de migrations e bootstrap do primeiro Master
    src/app/              Next.js (App Router): telas de acesso e rotas em api/
    src/server/           sessão, adaptadores Supabase e tratamento HTTP
    src/modules/<m>/      um módulo por domínio; importar apenas pelo index.ts
      identity-access  tenants-config  client-routine  document-intake
      import-processing  financial-core  receivables  reconciliation
      issues-approvals  closing-reporting  notifications  audit
    src/shared/           config (env), db (contexto de tenant), money, dates
    src/workers/          jobs assíncronos (Etapa 3)
    docs/                 verificação e decisões pendentes

A regra "importar só pelo index.ts" ainda é convenção; não há lint que a imponha.

## Como rodar
    cp .env.example .env            # preencher; não versionar
    docker compose up -d            # exige POSTGRES_PASSWORD e STORAGE_* no ambiente/.env
    npm install
    npm run db:migrate
    psql "$DATABASE_MIGRATION_URL" -c "CREATE ROLE bpo_app_login LOGIN PASSWORD '...' IN ROLE bpo_app"
    psql "$DATABASE_MIGRATION_URL" -v uid=<UID-do-Supabase-Auth> -v email=voce@empresa.com -v nome="Seu Nome" -f scripts/bootstrap-master.sql
    npm run dev

O bucket privado (`STORAGE_BUCKET`) será configurado na Etapa 3.

## Testes
    TEST_DATABASE_ADMIN_URL=postgres://postgres:...@localhost:5432/postgres npm test
Use um servidor descartável: os testes criam e removem bancos e roles.

## Regras para quem programa
- Rota nova usa `route()`; dado de cliente só por `inTenant()`. O proxy.ts não autoriza nada.
- Dinheiro: string/`Decimal`, nunca `number`. Datas de negócio: string `YYYY-MM-DD`.
- RLS é a segunda camada. Autorização por papel, escopo e condição é obrigação do servidor.
- Tabela nova precisa de: nenhum grant a anon/authenticated/service_role, RLS forçado, política, GRANT, gatilhos `no_delete`, `no_truncate` e `audit`.
- Para publicar um fechamento (Etapa 6), travar a linha de `period_closings` antes de calcular o snapshot.

## Etapa 5
- Telas: `/painel` (equipe BPO) e `/portal` (cliente). Ver `docs/etapa-5.md`.
- Aplique as migrações (`0015`) e valide os saldos iniciais antes do primeiro fechamento.
