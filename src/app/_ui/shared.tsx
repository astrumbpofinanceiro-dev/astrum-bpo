"use client";
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { supabaseBrowser } from "../_auth/browser-client";

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function api<T = any>(path: string, init?: { method?: string; body?: unknown; form?: FormData }): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: init?.method ?? (init?.body !== undefined || init?.form ? "POST" : "GET"),
    body: init?.form ?? (init?.body === undefined ? undefined : JSON.stringify(init.body)),
    headers: init?.body === undefined ? undefined : { "content-type": "application/json" },
  });
  const data = await response.json().catch(() => null);
  if (response.status === 401) window.location.assign("/login");
  if (data?.error === "MFA_REQUIRED") window.location.assign("/mfa");
  if (!response.ok) throw new Error(data?.error ?? "ERRO");
  return data as T;
}

/** Carrega um recurso; sem permissão, devolve null e o bloco não aparece. */
export function useApi<T = any>(path: string | null, version = 0): T | null {
  const [data, setData] = useState<T | null>(null);
  useEffect(() => {
    let live = true;
    setData(null);
    if (path) api<T>(path).then((d) => live && setData(d), () => live && setData(null));
    return () => { live = false; };
  }, [path, version]);
  return data;
}

export function useAction() {
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const run = useCallback(async (work: () => Promise<unknown>) => {
    setError("");
    try {
      const result = (await work()) as { pendingApprovalId?: string } | undefined;
      if (result?.pendingApprovalId) setError("Enviado para a segunda aprovação.");
    } catch (e) {
      setError(MESSAGES[(e as Error).message] ?? `Não foi possível concluir (${(e as Error).message}).`);
    }
    setVersion((v) => v + 1);
  }, []);
  return { error, version, run };
}

const MESSAGES: Record<string, string> = {
  FORBIDDEN: "Você não tem permissão para essa ação.",
  SECOND_PERSON_REQUIRED: "A aprovação precisa ser de outra pessoa.",
  PERIOD_CLOSED: "A competência está fechada.",
  CAVEAT_ISSUE_AWAITING_VALIDATION: "Há pendência respondida: valide ou devolva antes de publicar com ressalva.",
  ARQUIVO_RECUSADO: "Arquivo recusado: formato inválido ou corrompido.",
  ALREADY_CLOSED: "A competência já está fechada.",
  CAVEAT_ISSUES_MISMATCH: "A ressalva precisa listar todas as pendências bloqueantes.",
};

export const LABEL: Record<string, [string, string]> = {
  PENDING: ["Pendente", "warn"], SUBMITTED: ["Enviado", ""], COMPLETED: ["Concluído", "ok"], OVERDUE: ["Atrasado", "bad"], WAIVED: ["Dispensado", ""],
  NOT_STARTED: ["Não iniciado", ""], BLOCKED_BY_ISSUES: ["Com impedimentos", "bad"], READY_FOR_REVIEW: ["Pronto para revisão", "ok"],
  CLOSED_PUBLISHED: ["Publicado", "ok"], CLOSED_WITH_CAVEATS: ["Publicado com ressalva", "warn"], REOPENED: ["Reaberto", "warn"],
  COMPLETE: ["Completo", "ok"], PARTIAL: ["Parcial", "warn"], UNAVAILABLE: ["Indisponível", "bad"],
  PUBLISHED_FULL: ["Completo", "ok"], PUBLISHED_WITH_CAVEATS: ["Com ressalva", "warn"],
  WAITING_CLIENT_RESPONSE: ["Aguardando você", "warn"], ANSWERED_PENDING_BPO_VALIDATION: ["Em validação", ""],
  WAITING_BPO_ACTION: ["Com o BPO", ""], OPEN: ["Aberta", "warn"], RESOLVED: ["Resolvida", "ok"], ACCEPTED_WITH_CAVEAT: ["Ressalvada", "warn"],
};
export const Badge = ({ code }: { code: string }) => {
  const [text, tone] = LABEL[code] ?? [code, ""];
  return <span className={`badge ${tone}`}>{text}</span>;
};

export const brl = (v: string) => Number(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
export const day = (v: string) => v.slice(0, 10).split("-").reverse().join("/");
export const field = (e: FormEvent<HTMLFormElement>) => {
  e.preventDefault();
  return new FormData(e.currentTarget);
};
export const thisMonth = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date()).slice(0, 7);

export function Shell({ title, children }: { title: string; children: ReactNode }) {
  async function signOut() {
    await supabaseBrowser().auth.signOut();
    window.location.assign("/login");
  }
  return (
    <>
      <header>
        <img src="/astrum-logo.jpg" alt="Astrum BPO Financeiro" />
        <h1>{title}</h1>
        <button onClick={signOut}>Sair</button>
      </header>
      <main>{children}</main>
    </>
  );
}

/** Indicadores e as três visões, ao vivo (BPO) ou de uma versão publicada. */
export function Report({ data }: { data: any }) {
  const c = data.competence, k = data.cash, p = data.forecast;
  const rows = (list: [string, string | undefined][]) => (
    <table><tbody>{list.filter(([, v]) => v !== undefined).map(([name, v]) =>
      <tr key={name}><td>{name}</td><td className="num">{brl(v!)}</td></tr>)}</tbody></table>
  );
  return (
    <>
      <div className="cards">
        {data.indicators.map((i: any) => (
          <div className="card" key={i.code}>
            {i.label}
            <strong>{i.value === null ? "—" : i.unit === "%" ? `${i.value.replace(".", ",")}%` : brl(i.value)}</strong>
            <Badge code={i.quality} />
          </div>
        ))}
      </div>
      <h3>Competência</h3>
      {rows([["Receita bruta", c.grossRevenue], ["Deduções", c.deductions], ["Custos e despesas", c.costsAndExpenses],
        ["Taxas financeiras", c.financialFees], ["Resultado operacional", c.operatingResult],
        ["Juros e multas recebidos (fora do resultado)", c.interestAndFinesReceived], ["Juros e multas pagos (fora do resultado)", c.interestAndFinesPaid]])}
      <h3>Caixa</h3>
      {rows([["Saldo inicial", k.openingBalance], ["Entradas", k.inflows], ["Saídas", k.outflows], ["Geração líquida", k.netCashFlow], ["Saldo final", k.closingBalance]])}
      <h3>Previsão a partir de {day(p.from)}</h3>
      {rows([["A receber", p.receivables], ["A pagar", p.payables], ["Recebimentos vencidos", p.overdueReceivables], ["Pagamentos vencidos", p.overduePayables]])}
    </>
  );
}
