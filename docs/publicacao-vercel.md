# Publicar na Vercel (ambiente de TESTE, só dados fictícios)

## 1. GitHub (guarda o código)
1. Criar conta em github.com, se não houver.
2. Criar um repositório **privado** `astrum-bpo`, marcando "Add a README".
3. Conectar o GitHub ao Claude (Configurações > Conectores) para o código ser enviado, ou enviar o pacote manualmente.

## 2. Supabase (banco, login e arquivos)
1. Criar um projeto novo, região **South America (São Paulo)**.
2. SQL Editor: executar `astrum-banco-completo.sql` uma única vez.
3. SQL Editor: `CREATE ROLE bpo_app_login LOGIN PASSWORD '<senha forte>' IN ROLE bpo_app;`
4. Storage: criar o bucket **privado** `bpo-private`.
5. Authentication e API: seguir os itens 1 a 6 de `docs/etapa-2.md`.

## 3. Vercel
1. Criar conta no plano gratuito (**Hobby**), **somente para teste com dados fictícios**. Antes de usar com clientes ou cobrar pelo serviço, passar para o Pro ou outra hospedagem: o Hobby é restrito a uso não comercial. No Hobby a rotina agendada roda 1 vez por dia (06:17, horário de São Paulo, com até 1 h de variação).
2. Add New > Project > importar `astrum-bpo`.
3. Environment Variables (digitar direto na Vercel; **não enviar senhas pelo chat**):

| Nome | Valor |
|---|---|
| `APP_ENV` | `staging` (ambiente de teste) |
| `APP_URL` | endereço final, ex. `https://astrum-bpo.vercel.app` |
| `DATABASE_URL` | pooler em modo transação, usuário `bpo_app_login.<project-ref>` |
| `DATABASE_CA_CERT` | certificado em Database > SSL |
| `NEXT_PUBLIC_SUPABASE_URL` | URL do projeto |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | chave publicável |
| `SUPABASE_SECRET_KEY` | chave secreta |
| `STORAGE_BUCKET` | `bpo-private` |
| `SIGNED_URL_TTL_SECONDS` | `300` |
| `PROCESS_INLINE` | `true` |
| `CRON_SECRET` | texto aleatório com 32 caracteres ou mais |

4. Deploy. Depois, conferir `APP_URL` e o "Site URL" do Supabase com o endereço real.

## 4. Primeiro usuário
Criar em Supabase > Authentication e executar `scripts/bootstrap-master.sql` (ver `docs/etapa-2.md`, item 10).

## Domínio próprio
Vercel > Settings > Domains > adicionar `app.suaempresa.com.br` e criar o registro DNS indicado.
