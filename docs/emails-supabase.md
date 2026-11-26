# Modelos de e-mail do Supabase (português)

Onde: Supabase → Authentication → Emails → Templates. Em cada modelo troque o assunto e o conteúdo (modo "Source").
O link **precisa** usar `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=...`; é ele que abre a tela de criar senha.
Antes: Authentication → URL Configuration → Site URL = `https://astrum-bpo.vercel.app`.

## Invite user
Assunto: `Você foi convidado para a Astrum BPO Financeiro`
```html
<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;color:#1a2738">
  <h2 style="color:#1f2f46">Bem-vindo(a) à Astrum BPO Financeiro</h2>
  <p>Você recebeu um convite para acessar a plataforma. Clique no botão abaixo para criar sua senha.</p>
  <p style="margin:28px 0"><a href="{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=invite"
     style="background:#3f6b48;color:#fff;padding:14px 22px;border-radius:10px;text-decoration:none;font-weight:bold">Criar minha senha</a></p>
  <p style="font-size:13px;color:#5a6779">O link vale por tempo limitado e só pode ser usado uma vez. Se o botão não funcionar, copie e cole no navegador:<br>{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=invite</p>
  <p style="font-size:13px;color:#5a6779">Se você não esperava este convite, ignore esta mensagem.</p>
</div>
```

## Reset password
Assunto: `Crie uma nova senha – Astrum BPO Financeiro`
```html
<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;color:#1a2738">
  <h2 style="color:#1f2f46">Redefinir sua senha</h2>
  <p>Recebemos um pedido para criar uma nova senha. Clique no botão abaixo para continuar.</p>
  <p style="margin:28px 0"><a href="{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=recovery"
     style="background:#3f6b48;color:#fff;padding:14px 22px;border-radius:10px;text-decoration:none;font-weight:bold">Criar nova senha</a></p>
  <p style="font-size:13px;color:#5a6779">O link vale por tempo limitado e só pode ser usado uma vez. Se o botão não funcionar, copie e cole no navegador:<br>{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=recovery</p>
  <p style="font-size:13px;color:#5a6779">Se você não pediu, ignore esta mensagem: sua senha continua a mesma.</p>
</div>
```
