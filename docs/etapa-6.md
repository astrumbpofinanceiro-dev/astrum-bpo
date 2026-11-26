# Etapa 6 — Testes automatizados

## Resultado
88 testes passando (três rodadas seguidas), checagem de tipos e build. Banco PostgreSQL 16 descartável;
login e armazenamento simulados. Sem migração nova.

## Cenários do Documento 3 §7 (`db/tests/scenarios.test.ts`)
| # | Cenário | Situação |
|---|---|---|
| 1 | Isolamento e Modo Cego | Passa |
| 2 | Arquivo repetido e período sobreposto | Passa |
| 3 | Competência x caixa | Passa |
| 4 | Antecipação total | Passa |
| 5 | Antecipação parcial | Passa |
| 6 | Três vendas, um depósito | **Ressalva:** ver decisão 1 |
| 7 | Chargeback | Passa |
| 8 | Transferência interna | Passa |
| 9 | Pendência bloqueante | Passa (pendência aberta manualmente) |
| 10 | Versão, ressalva e reabertura | Passa |

## Outras coberturas (`db/tests/guarantees.test.ts`)
- Todas as rotas de cliente, com quatro perfis do Cliente A contra o Cliente B.
- Modo Cego em todas as rotas de leitura.
- Mesmo arquivo com dois processadores simultâneos; relatório de maquininha aplicado duas vezes.
- Bloqueios do checklist, pendência crítica, regras da ressalva e imutabilidade da versão.

## Correções feitas nesta etapa (falhas da Etapa 5)
- A ressalva aceitava pendência respondida e aguardando validação, transição ausente no Doc 1 §2.6.
  Agora é preciso validar ou devolver antes.
- O fechamento passava a "publicado" sem gravar o estado intermediário do Doc 1 §2.7.

## Decisões pendentes
1. **Cenário 6 com relatório importado.** O lote gera um repasse único com três parcelas, e o depósito
   é conciliado com 1 alocação. O documento pede 3. Com um repasse por venda (lançamento manual) dá 3.
   Valores, status e receita estão corretos nos dois caminhos.
2. **Arquivo ainda na fila não impede o fechamento.** O Doc 3 §5.1 cita só sobreposição em revisão e
   falha de importação. Depois de fechado, a importação desse arquivo é bloqueada.
3. **Cenário 9.** O sistema não abre sozinho a pendência de saída sem comprovante; o analista abre.
4. **Cenário 1.** O funcionário vê os próprios lançamentos ainda não aprovados; os aprovados ficam
   ocultos, conforme o Modo Cego.

## Não coberto
Supabase real, arquivos reais de banco e maquininha, testes automáticos das telas, carga e a
homologação que o documento também exige.
