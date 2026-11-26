"use client";
import { useEffect, useState, type FormEvent } from "react";
import { supabaseBrowser } from "../_auth/browser-client";

export default function DefinirSenha() {
  const [error, setError] = useState("");

  useEffect(() => {
    // Conta com segundo fator precisa confirmá-lo antes de trocar a senha.
    supabaseBrowser().auth.mfa.getAuthenticatorAssuranceLevel().then(({ data }) => {
      if (data && data.nextLevel === "aal2" && data.currentLevel !== "aal2") {
        window.location.assign("/mfa?next=/definir-senha");
      }
    });
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const password = String(data.get("password"));
    if (password !== String(data.get("confirm"))) return setError("As duas senhas precisam ser iguais.");
    const supabase = supabaseBrowser();
    const { error: updateError } = await supabase.auth.updateUser({ password });
    if (updateError) return setError("Senha não aceita. Use uma senha longa e não reutilizada.");
    await supabase.auth.signOut();
    window.location.assign("/login?senha=ok");
  }

  return (
    <main className="auth">
      <img className="auth-logo" src="/astrum-logo.jpg" alt="Astrum BPO Financeiro" />
      <h1>Crie sua senha</h1>
      <p>Use pelo menos 12 caracteres. Uma frase longa é mais segura e fácil de lembrar.</p>
      <form onSubmit={submit}>
        <label>Nova senha <input name="password" type="password" autoComplete="new-password" minLength={12} required /></label>
        <label>Repita a senha <input name="confirm" type="password" autoComplete="new-password" minLength={12} required /></label>
        <button>Salvar senha</button>
      </form>
      <p role="alert">{error}</p>
    </main>
  );
}
