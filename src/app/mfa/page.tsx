"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { safeNext, supabaseBrowser } from "../_auth/browser-client";

/** Cadastra o autenticador (TOTP) no primeiro acesso e pede o código nos demais. */
export default function Mfa() {
  const [factorId, setFactorId] = useState("");
  const [qr, setQr] = useState<{ image: string; secret: string } | null>(null);
  const [error, setError] = useState("");
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    (async () => {
      const { mfa } = supabaseBrowser().auth;
      const { data, error: listError } = await mfa.listFactors();
      if (listError) return window.location.assign("/login");
      if (data.totp[0]) return setFactorId(data.totp[0].id);
      // Remove cadastros abandonados antes de criar outro.
      for (const f of data.all.filter((x) => x.status === "unverified")) await mfa.unenroll({ factorId: f.id });
      const enrolled = await mfa.enroll({ factorType: "totp" });
      if (enrolled.error) return setError("Não foi possível iniciar o cadastro do autenticador.");
      setQr({ image: enrolled.data.totp.qr_code, secret: enrolled.data.totp.secret });
      setFactorId(enrolled.data.id);
    })();
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const code = String(new FormData(event.currentTarget).get("code")).trim();
    const { error: verifyError } = await supabaseBrowser().auth.mfa.challengeAndVerify({ factorId, code });
    if (verifyError) return setError("Código inválido.");
    window.location.assign(safeNext(new URLSearchParams(window.location.search).get("next")));
  }

  return (
    <main className="auth">
      <img className="auth-logo" src="/astrum-logo.jpg" alt="Astrum BPO Financeiro" />
      <h1>Verificação em duas etapas</h1>
      {qr && (
        <section>
          <p>Leia o QR Code no seu aplicativo autenticador.</p>
          <img src={qr.image} alt="QR Code do autenticador" width={200} height={200} />
          <p>Chave manual: <code>{qr.secret}</code></p>
        </section>
      )}
      <form onSubmit={submit}>
        <label>Código de 6 dígitos <input name="code" inputMode="numeric" autoComplete="one-time-code" required /></label>
        <button disabled={!factorId}>Confirmar</button>
      </form>
      <p role="alert">{error}</p>
    </main>
  );
}
