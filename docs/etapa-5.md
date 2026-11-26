# Etapa 5 — Fechamento, relatórios e portais

## Entregue
- Checklist de fechamento com os seis critérios do Doc 3 §5.1, listando o que impede.
- Publicação completa e com ressalva (justificativa, prazo, responsável, pendências listadas).
- Versões imutáveis com o retrato dos números; reabertura com motivo; nova versão substitui a anterior.
- Validação do saldo inicial (Revisor ou Master).
- Relatórios de competência, caixa e previsão; 7 indicadores COMPLETO / PARCIAL / INDISPONÍVEL.
- Rotina do cliente e checklist; painel `/painel`; portal `/portal` com a identidade Astrum.
- Segunda aprovação por cliente (D11): `DUAL_APPROVAL_ENABLED` (padrão desligada) e `DUAL_APPROVAL_THRESHOLD`.
- Pendência reaberta volta ao responsável original.

## Verificação
- 69 testes, checagem de tipos, build e atualização de um banco da Etapa 4.
- Cobertos: totais dos cenários 3, 4 e 8; fluxo de fechamento, reabertura e nova versão (9 e 10).
  A bateria completa dos 10 cenários é a Etapa 6.
- Telas conferidas com dados simulados. Nada foi testado em um projeto Supabase real.

## Interpretações a validar
- H1. Segunda aprovação: com a política ligada, ressalva e reabertura sempre pedem; estorno de venda,
  repasse ou antecipação pede a partir do valor definido (sem valor definido, sempre).
  Desfazer conciliação não passa por ela. Quem aprova: Revisor ou Master, nunca quem pediu.
- H2. Indicador PARCIAL: qualquer pendência não resolvida (exceto aviso), operação aguardando
  conferência ou ressalva no mês marca todos os indicadores calculáveis.
- H3. Indicador INDISPONÍVEL: caixa, se falta validar saldo ou importar extrato de alguma conta corrente;
  cartão, se a entrega do relatório da maquininha está pendente na rotina. Um extrato com movimentos
  em apenas parte do mês conta como importado.
- H4. Conciliação do checklist: soma do que falta conciliar nos lançamentos bancários do mês.
- H5. Cliente vê apenas a versão vigente; versões substituídas ficam para a equipe.
- H6. Funcionário vê os itens de rotina das unidades do seu escopo (não há atribuição por pessoa).
- H7. Juros e multas continuam fora do resultado, exibidos em linhas próprias (D9).
- H8. A previsão usa a situação atual das parcelas; não reconstrói como estava em uma data passada.
  O valor de uma versão publicada fica preservado no retrato.

## Limites conhecidos
- Compra ou despesa já aprovada continua sem caminho de correção, mesmo após reabrir (Exceção 7).
  Precisa de regra aprovada.
- O painel cobre fechamento, pendências, saldos, rotina e aprovações. Cadastros, conferência de
  documentos, operações e conciliação continuam apenas na API, sem tela.
- Não há tela para ligar a segunda aprovação, nem para editar ou desativar rotina.
- A ressalva criada pela tela tem como responsável quem publica; a API aceita outra pessoa.
- Criar rotina exige Master BPO.
