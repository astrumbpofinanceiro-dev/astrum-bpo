"use client";
import { useEffect, useState } from "react";
import { api } from "./_ui/shared";

/** Encaminha para o painel (equipe) ou para o portal (cliente). */
export default function Home() {
  const [error, setError] = useState("");
  useEffect(() => {
    api<{ isBpoMaster: boolean; assignments: unknown[] }>("/me").then(
      (me) => window.location.assign(me.isBpoMaster || me.assignments.length ? "/painel" : "/portal"),
      () => setError("Sem acesso."));
  }, []);
  return <main><p>{error || "Carregando…"}</p></main>;
}
