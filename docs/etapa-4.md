# Etapa 4 — Motor financeiro, cartões e conciliação

## Decisões aprovadas em 26/11/2026
| # | Decisão |
|---|---|
| D7 | Taxa de cartão na competência do mês da venda |
| D8 | Estorno de parcela em aberto em campo próprio (`cancelled_amount`); bruto original intacto |
| D9 | Juros e multa registrados à parte, com justificativa |
| D10 | Liquidação e antecipação erradas marcadas como estornadas, com motivo |

## Entregue (somente API)
Operações com parcelas; venda no cartão com MDR e agenda; repasse; antecipação total e parcial; estorno e
chargeback; relatório de adquirente virando venda, repasse e antecipação; conciliação 1:1, N:1 e 1:N;
sugestões por valor e data; transferência interna de duas pernas.

## Verificação
Testes das partes de dados dos cenários 3 a 8 do Doc 3. Os totais de competência, caixa e previsão desses
cenários dependem dos relatórios (Etapa 5). Não testado contra Supabase nem com arquivos reais.

## Escolhas que precisam de aprovação
| # | Escolha aplicada |
|---|---|
| G1 | Se o mês da venda já está **fechado**, a taxa informada depois entra no mês do repasse (Doc 1, Exceção 7). Sem isso, nenhum repasse posterior ao fechamento poderia ser lançado |
| G2 | Estorno parcial reduz primeiro as últimas parcelas em aberto |
| G3 | Sem valor por parcela, a divisão deixa a sobra de centavos na última |
| G4 | Estorno só por Revisor/Master e já nasce aprovado; as demais operações aguardam aprovação |
| G5 | Analista concilia e desfaz conciliação; estornar liquidação ou antecipação é de Revisor/Master |
| G6 | Juros/multa só quando o principal da parcela fica quitado |
| G7 | Tolerância configurável em `RECONCILIATION_TOLERANCE` (padrão 0,05); sugestão para parcela exige valor exato |
| G8 | Caixa físico só concilia depois de aprovado |

## O que não está feito
- Conciliação automática por NSU/FITID (nível 1 do Doc 3 §2.1): nada é conciliado sem confirmação.
- Dias úteis ignoram feriados.
- Parcela vencida aparece como indicador `overdue`; o estado `OVERDUE` não é gravado. Sem baixa (`WRITTEN_OFF`).
- Fatura de cartão corporativo.
- Linhas de chargeback do relatório da adquirente ficam pendentes para estorno manual.
- Corrigir operação **já aprovada**: só por estorno (vendas e serviços). Compras e despesas aprovadas ainda não têm correção.
- Na Etapa 5, o item `CHARGEBACK` não deve somar em "taxas", pois o estorno já é dedução.

## Antes da Etapa 5
**D11. Dupla aprovação** (fechamento com ressalva, reabertura, ajustes relevantes): obrigatória sempre ou
conforme política? O que é "relevante"?
**D4 (resto).** Para onde vai uma pendência reaberta.

## Para rodar
`npm run db:migrate` aplica a `0014`.
