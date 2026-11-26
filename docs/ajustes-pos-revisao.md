# Ajustes pós-revisão (migração 0016 e correções)

Decisões aprovadas pelo cliente após a revisão do código.

1. **Região** — `vercel.json` em `iad1` (perto do Supabase us-east-1). Usar somente dados fictícios até o banco estar em São Paulo (LGPD).
2. **Cartão corporativo** — extrato bancário (OFX/CSV) em conta `CORPORATE_CARD` é recusado no upload (`CARD_ACCOUNT_BANK_STATEMENT`) e pelo banco (gatilho `no_card_bank_tx`, migração 0016). Fluxo da fatura: registrar cada compra como despesa com vencimento na data da fatura e pagar por **conciliação N:1** do débito bancário (teste permanente em `db/tests/cartao.test.ts`). Provisório: vale até existir a entidade "fatura".
3. **Fechamento** — novo item `NO_QUEUED_BATCHES` ("Sem arquivos na fila de processamento"): lotes `UPLOADED`, `VALIDATING`, `IMPORTING` e `READY_TO_IMPORT` do mês (ou sem período conhecido) bloqueiam a publicação completa **e** a com ressalva. É uma extensão da especificação (Doc 3 §5.1).
4. **Cenário 6** — o repasse importado gera **um evento por venda** (data + NSU), com líquido e ajuste de centavos por evento. A antecipação importada continua sendo uma só, com um evento por venda dentro dela; o estorno desfaz todos. O crédito bancário único é sugerido pela **soma** dos eventos pendentes da mesma conta e data (`combinations` em `/reconciliations/suggestions`).
   - API manual: `items[].netAmount` (opcional) habilita a divisão por venda na antecipação; sem ele mantém-se um evento só.

Testes: 95 passando (`db/tests/cartao.test.ts`, `fila-fechamento.test.ts`, cenário 6 em `scenarios.test.ts`).

## Cadastros (API e tela)
- Rotas novas: `GET/POST /categories`, `PATCH /categories/:id`, `GET/POST /cost-centers`, `PATCH /cost-centers/:id` (permissão `structure.view` / `structure.manage`; só o Master BPO altera; funcionário em Modo Cego não lista). Categoria: código, natureza e pai não mudam depois de criados; só nome e situação (ativo/inativo). Auditoria pelos gatilhos existentes (inclui a marca de suporte do Master).
- Tela `/cadastros`: empresa, unidades, contas, cartões, adquirentes, plano de contas (em árvore) e centros de custo. Celular: abas roláveis, formulário em folha deslizante; computador: lista em duas colunas e formulário em janela. Sem rolagem lateral em 390, 820 e 1366 px.
- Master BPO precisa abrir o acesso de suporte (60 min, com motivo) para a empresa; a tela oferece o formulário.

## Etiquetas de contrato (migração 0017)
- Etiqueta = código livre do contrato/turma (ex.: "Medicina XXVII – Bruna"). Uma etiqueta por operação; uma etiqueta em muitas operações (os 20 alunos do contrato).
- API: `GET/POST /tags`, `PATCH /tags/:id` (só Master BPO altera; funcionário em Modo Cego não lista), `tagId` opcional ao criar operação, `GET /tag-report?month=` (sem mês = acumulado do contrato; `finance.view`).
- O relatório usa a competência das operações aprovadas. Taxas de cartão e juros não são rateados por etiqueta; etiquetas + "sem etiqueta" fecham com a receita e os custos do relatório geral.
- Limite atual: a etiqueta é escolhida na criação da operação (API). Ainda não há tela de lançamento nem edição da etiqueta de operação já criada. Contrato com valor total e previsto x realizado fica para depois.
Testes: 104 passando.
