"use client";
import { useState, type FormEvent } from "react";
import { supabaseBrowser } from "../_auth/browser-client";

export default function RecuperarSenha() {
  const [sent, setSent] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await supabaseBrowser().auth.resetPasswordForEmail(String(new FormData(event.currentTarget).get("email")));
    setSent(true); // mesma resposta exista ou não a conta
  }

  return (
    <main className="auth">
      <img className="auth-logo" src="/astrum-logo.jpg" alt="Astrum BPO Financeiro" />
      <h1>Recuperar senha</h1>
      {sent ? <p>Se o e-mail estiver cadastrado, você receberá um link.</p> : (
        <form onSubmit={submit}>
          <label>E-mail <input name="email" type="email" required /></label>
          <button>Enviar link</button>
        </form>
      )}
    </main>
  );
}
