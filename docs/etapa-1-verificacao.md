# Etapa 1 — Verificação contra o Documento 2

Verificado em PostgreSQL 16: migrations aplicadas (inclusive com dono não superusuário), reexecução sem efeito, 27 testes automatizados, typecheck e `next build`. O alvo mínimo é PostgreSQL 15; não testei na versão 15.

## Entidades: 36 de 36, com todas as colunas
| Domínio | Tabelas |
|---|---|
| A. Identidade e rotina (9) | tenants, users, bpo_staff_assignments, tenant_memberships, user_scopes, business_units, client_settings, client_routines, routine_items |
| B. Contas e plano (6) | financial_accounts, acquirers, payment_terminals, accounting_categories, cost_centers, tags |
| C. Documentos e lotes (4) | documents, document_files, import_batches, batch_items |
| D. Núcleo financeiro (13) | economic_operations, financial_obligations, obligation_installments, receivable_anticipations, anticipation_allocations, settlement_events, settlement_allocations, settlement_fee_items, bank_transactions, cash_transactions, internal_transfers, reconciliation_groups, reconciliation_allocations |
| E. Governança (4) | blocking_issues, period_closings, closing_versions, audit_logs |

Extras (pendentes de aprovação): ai_processing_logs, closing_version_issues.
Exclusão lógica: `deleted_at` em documents, economic_operations e cash_transactions (convenção §0).

## Constraints e índices do Documento 2
| Exigência | Situação |
|---|---|
| Uniques: tax_id, email, atribuição ativa, membership, idempotency_key, competência, versão | OK |
| CHECKs: gross_amount >= 0, settled <= gross, transferência (contas diferentes, valor > 0), dia 1 na competência | OK |
| Índices nomeados: settings, documents, hash, itens externos, auditoria | OK |
| NUMERIC(15,2) em valores; sem float (única exceção: custo de IA, 6 casas) | OK, testado |
| DATE para negócio, TIMESTAMPTZ para eventos | OK |
| Sem ON DELETE CASCADE | OK, testado |
| RLS em todas as tabelas com tenant_id | OK, forçado; também em tenants |

## Além do Documento 2 (regras dos outros documentos no banco)
- FKs compostas `(tenant_id, id)`: impedem referência entre tenants.
- Alocações: antecipação, liquidação e conciliação não excedem o saldo, inclusive sob concorrência.
- Estado de conciliação recalculado; reversão preserva o histórico.
- Imutáveis: auditoria, arquivos, data original prevista, versões publicadas. Sem DELETE.
- Competência fechada bloqueia inclusão e edição; liquidação posterior de parcela continua permitida.
- CRITICAL nunca aceita ressalva; bloqueante não vai de "aguardando cliente" para resolvida.
- Ressalva exige justificativa (20+), prazo, responsável e pendências vinculadas.
- Lançamento do cliente só nasce como rascunho ou aguardando BPO.
- Idempotência: FITID por conta, item de lote efetivado uma vez, chave de lote.
- Auditoria automática; escrita sem ator é recusada; Master em cliente exige motivo.
- RLS: duas políticas extras permitem ao usuário ler os próprios vínculos antes de escolher o tenant.

## O que o banco NÃO garante ainda
| Item | Etapa |
|---|---|
| Papéis, carteira do analista, escopos, Modo Cego, HTTP 403, log de tentativa negada | 2 |
| Tabela `users` é legível por inteiro pela role da aplicação (não tem tenant_id) | 2 |
| Sessão de suporte do Master com início e fim | 2 |
| Máquinas de estado completas (só as transições críticas acima estão no banco) | 2–5 |
| Consistência bruto − taxas = líquido, tolerância de R$ 0,05, settled_amount derivado das alocações | 3–4 |
| Direção da movimentação compatível com a obrigação conciliada | 4 |
| Bloqueio de publicação com pendência aberta (checklist do Doc 3 §5.1) | 5 |
| Os 10 cenários de aceite completos (há apenas partes de banco dos cenários 4, 6, 8, 9 e 10) | 6 |
