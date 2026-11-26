"use client";
import { useState, type FormEvent } from "react";
import { supabaseBrowser } from "../_auth/browser-client";

export default function Login() {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const data = new FormData(event.currentTarget);
    const supabase = supabaseBrowser();
    const result = await supabase.auth.signInWithPassword({
      email: String(data.get("email")), password: String(data.get("password")),
    });
    if (result.error) {
      setError("E-mail ou senha inválidos, ou muitas tentativas.");
      setBusy(false);
      return;
    }
    // Quem precisa de MFA e ainda não está em AAL2 é levado ao segundo fator.
    const me = await fetch("/api/me");
    window.location.assign(me.status === 403 ? "/mfa" : "/");
  }

  return (
    <main className="auth">
      <img className="auth-logo" src="/astrum-logo.jpg" alt="Astrum BPO Financeiro" />
      <h1>Entrar</h1>
      <form onSubmit={submit}>
        <label>E-mail <input name="email" type="email" autoComplete="username" required /></label>
        <label>Senha <input name="password" type="password" autoComplete="current-password" required /></label>
        <button disabled={busy}>{busy ? "Entrando…" : "Entrar"}</button>
      </form>
      <p role="alert">{error}</p>
      <a href="/recuperar-senha">Esqueci minha senha</a>
      <aside className="auth-note">
        <strong>Primeiro acesso?</strong>
        <p>O acesso é só por convite. Abra o e-mail de convite que você recebeu, defina sua senha e ative o aplicativo autenticador.</p>
        <p>Ainda não recebeu? Peça ao responsável pela sua empresa ou ao seu BPO Astrum para enviar um convite.</p>
      </aside>
    </main>
  );
}
