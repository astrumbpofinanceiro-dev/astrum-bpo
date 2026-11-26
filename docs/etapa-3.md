# Etapa 3 — Coleta, triagem, lançamento manual e pendências

Autorizada em 26/11/2026, com E1–E10, P1 e P2 aprovados. Sem arquivos de exemplo (P3 segue aberto).

## Entregue (somente API; telas na Etapa 5)
- Upload privado com SHA-256; original nunca sobrescrito; download por URL assinada de curta duração.
- Rejeição de vazio, tipo não aceito ou conteúdo diferente da extensão (não armazena).
- Leitores OFX, CSV e XLSX; fila com worker, 3 tentativas com espera crescente e reprocessamento.
- Arquivo repetido, itens repetidos e sobreposição com decisão humana. Cenário 2 do Doc 3 coberto com OFX.
- Triagem de documentos; lançamento manual com conferência do BPO; pendências com resposta e validação.

## Como usar os arquivos
Extrato/CSV padrão: colunas `bank_posting_date`, `amount` (negativo = saída), `description`, `external_fitid`
(opcional). Outros títulos: informar `mapping` no envio. Adquirente: nomes de campo do Doc 3 §1.2.
Datas `AAAA-MM-DD` ou `DD/MM/AAAA`. `1.234` (ponto sem centavos) é recusado por ser ambíguo.

## Escolhas que precisam de aprovação
| # | Escolha aplicada |
|---|---|
| F1 | Todo lançamento manual vira registro de **caixa físico**, só em conta do tipo caixa. Despesa e pagamento declarado = saída; resumo diário e recebimento declarado = entrada. Nenhum gera receita/despesa por competência: isso fica para o BPO na Etapa 4 |
| F2 | Envio de funcionário vai só para triagem, mesmo sendo extrato; não cria movimentação |
| F3 | Revisor e Master aprovam, devolvem e recusam lançamentos; Analista apenas inicia a conferência |
| F4 | Exigência de comprovante vale para saídas acima de `MANUAL_RECEIPT_THRESHOLD`; severidade em `MANUAL_RECEIPT_SEVERITY` (padrão WARNING) |
| F5 | `CLIENT_MANUAL_ENTRY_ENABLED` ausente = permitido (respeitando o escopo) |
| F6 | Duplicidade de adquirente considera NSU + parcela + **tipo de evento** (o Doc 3 cita só NSU + parcela; assim a liquidação não é descartada como repetição da venda) |
| F7 | Saldo inicial/final é conferido quando informado no envio; o OFX padrão traz só o saldo final |
| F8 | Toda resolução de pendência, inclusive informativa, é de Revisor ou Master |
| F9 | Lote que falhou por indisponibilidade reinicia do começo (nada havia sido gravado) |
| F10 | Colunas fora do Doc 2 na migration 0013; pendência passa a aceitar alvo `CASH_TRANSACTION` |

## Limites desta etapa
- Relatório de adquirente é lido, validado e deduplicado, mas **não gera vendas nem parcelas** (Etapa 4).
- Layouts reais de bancos e adquirentes não foram testados.
- Sem antivírus. Limite de 8 MB por arquivo e 20.000 linhas; planilha compactada muito grande não é barrada antes da leitura.
- Hospedagens com limite menor de corpo de requisição (ex.: funções serverless) exigiriam upload direto ao storage.
- PDF, imagem e XML vão para triagem sem leitura automática. Sem OCR ou IA.
- Ressalva e reabertura de pendência ficam para a Etapa 5.
- Storage, login e e-mails do Supabase não foram testados contra um projeto real (storage simulado nos testes).

## Para rodar
1. Aplicar a migration `0013` (`npm run db:migrate`).
2. No Supabase Storage, criar o bucket **privado** `bpo-private` (ou definir `STORAGE_BUCKET`).
3. Rodar a aplicação e, em outro processo, `npm run worker`.
