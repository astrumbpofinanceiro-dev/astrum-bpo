> Atualização de 26/11/2026: D7 a D10 aprovadas (ver `etapa-4.md`). D11 segue aberta.

> Atualização de 26/11/2026: aprovadas as escolhas E1 a E10 e os campos P1 e P2 (ver `etapa-3.md`).

> Atualização de 25/11/2026: aprovados D1 (Supabase com MFA), D2, D3, D4 (união das listas) e D5.
> Seguem abertos: REOPENED (em D4), D6 a D11, e os itens de `etapa-2.md`.

# Decisões pendentes de aprovação

## Antes da Etapa 2
**D1. Credenciais e sessão.** O Doc 2 não tem senha, MFA nem sessão em `users`; a Etapa 2 exige autenticação.
Proposta: provedor gerenciado com MFA (ex.: Supabase Auth, se o banco for Supabase) ou biblioteca no próprio app com tabelas novas. Precisa saber onde o sistema será hospedado.

**D2. Ator técnico `SYSTEM_WORKER`.** `audit_logs.actor_user_id` é obrigatório e jobs não têm usuário. Incluí no código um papel técnico `SYSTEM_WORKER`, que não está nos 6 perfis do Doc 1. Não concede permissão no banco. Aprovar ou indicar alternativa.

**D3. Complementos da migration 0007** (não previstos no Doc 2):
| # | Complemento | Motivo |
|---|---|---|
| C1 | `economic_operations.reversal_of_operation_id` (obrigatório em estorno) | Doc 3 §3.3 |
| C2 | `reconciliation_status` em caixa e transferências | Doc 1 §2.5 |
| C3 | `settlement_events.anticipation_id` | ver D5 |
| C4 | `closing_versions.caveat_responsible_user_id` e tabela `closing_version_issues` | Doc 1 §2.7, Doc 3 §5.2 |
| C5 | tabela `ai_processing_logs` | Doc 3 §6 |
| C6 | `audit_logs.source` e `correlation_id` | Estrutura v3.1 §16 |

**D4. Listas de estados divergentes entre Doc 1 e Doc 2.** Apliquei a união das duas, sem criar estado novo:
- lote: Doc 1 tem `REJECTED` e `PARTIALLY_IMPORTED`, ausentes no Doc 2;
- item de lote: Doc 1 usa `IGNORED_DUPLICATE` e `REJECTED`; Doc 2 usa `IGNORED`;
- parcela: Doc 1 tem `WRITTEN_OFF`, ausente no Doc 2;
- pendência `REOPENED`: o Doc 1 não define para onde ela pode ir (proposta: para `WAITING_CLIENT_RESPONSE` ou `WAITING_BPO_ACTION`).

## Antes da Etapa 3
**D6. Layouts concretos.** Quais bancos e adquirentes do piloto? Preciso de arquivos de exemplo anonimizados (OFX, CSV, XLSX). A própria Estrutura v3.1 §6 pede isso antes dos importadores.

## Antes da Etapa 4
**D5. Antecipação x liquidação.** `settlement_fee_items` exige um `settlement_event`, então a antecipação gera uma liquidação; sem vínculo, o bruto da parcela seria consumido duas vezes.
Proposta (C3): liquidação ligada à antecipação não consome saldo novamente.

**D7. Competência das taxas.** `settlement_fee_items` não tem data de competência, mas o Doc 3 §4.1 soma taxas por competência. Venda em novembro liquidada em dezembro: a taxa é de qual mês?
Proposta: competência da venda de origem. A decisão afeta o que um fechamento publicado bloqueia.

**D8. Estorno parcial de parcela aberta de competência já fechada.** O Doc 3 §3.3 manda reduzir a parcela; o Doc 1 torna a competência imutável. Hoje o banco permite cancelar (status), mas bloqueia reduzir o valor.
Proposta: registrar o valor cancelado em campo próprio, sem alterar o bruto.

**D9. Juros e multa.** O Doc 3 §2.2 permite exceder o valor com lançamento explícito, mas não há campo nem tipo para isso. Hoje o banco bloqueia qualquer excesso.

**D10. Desfazer liquidação ou antecipação.** Não há estado de reversão no Doc 2. Hoje é possível apenas zerar a alocação (fica auditado), sem apagar.

## Antes da Etapa 5
**D11. Dupla aprovação.** O Doc 1 §1 diz que é obrigatória (ressalva, reabertura, ajustes relevantes); a matriz §3 diz "quando exigido pela política". Não há onde registrar a aprovação de reabertura ou ajuste, e "relevante" não tem limite definido.
Estado atual: o 2º aprovador é opcional, mas se informado precisa ser outra pessoa.
Proposta: obrigatória, com tabela `approval_records`.

## Lacunas menores (sem tabela ou campo no Doc 2)
- Anexos na resposta de pendência (Estrutura v3.1 §12).
- Vínculo de tags aos registros (`record_tags`).
- Definições e versões de fórmula de indicadores (v3.1 §14).
- Motivo tipificado de revisão de previsão (v3.1 §9.4): hoje fica em `audit_logs` (antes, depois, motivo em texto).
- `receivable_schedules` é citada nos Docs 1 e v3.1, mas o Doc 2 a representa em `obligation_installments`; segui o Doc 2.
