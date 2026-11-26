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
    const password = String(new FormData(event.currentTarget).get("password"));
    const supabase = supabaseBrowser();
    const { error: updateError } = await supabase.auth.updateUser({ password });
    if (updateError) return setError("Senha não aceita. Use uma senha longa e não reutilizada.");
    await supabase.auth.signOut();
    window.location.assign("/login");
  }

  return (
    <main className="auth">
      <img className="auth-logo" src="/astrum-logo.jpg" alt="Astrum BPO Financeiro" />
      <h1>Definir senha</h1>
      <form onSubmit={submit}>
        <label>Nova senha <input name="password" type="password" autoComplete="new-password" minLength={12} required /></label>
        <button>Salvar</button>
      </form>
      <p role="alert">{error}</p>
    </main>
  );
}
