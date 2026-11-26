"use client";
import { useEffect, useState, type FormEvent } from "react";
import { api, Badge, brl, day, field, Report, Shell, thisMonth, useAction, useApi } from "../_ui/shared";

/* eslint-disable @typescript-eslint/no-explicit-any */
const ACTION: Record<string, string> = {
  PUBLISH_WITH_CAVEATS: "Publicar com ressalva", REOPEN: "Reabrir competência", REFUND: "Estorno de venda",
  REVERSE_SETTLEMENT: "Estornar repasse", REVERSE_ANTICIPATION: "Estornar antecipação",
};

/** Uma linha da carteira: situação do mês e carga de trabalho da empresa. */
function PortfolioRow({ tenant, month, version, onOpen }: { tenant: any; month: string; version: number; onOpen: () => void }) {
  const base = `/tenants/${tenant.id}`;
  const closing = useApi<any>(`${base}/closing?month=${month}`, version);
  const issues = useApi<any[]>(`${base}/issues`, version);
  const items = useApi<any[]>(`${base}/routine-items?month=${month}`, version);
  return (
    <tr>
      <td>{tenant.trade_name}</td>
      <td>{closing ? <Badge code={closing.status} /> : "—"}</td>
      <td className="num">{issues ? issues.filter((i) => !["RESOLVED", "ACCEPTED_WITH_CAVEAT"].includes(i.status)).length : "—"}</td>
      <td className="num">{items ? items.filter((i) => i.status === "OVERDUE").length : "—"}</td>
      <td><button onClick={onOpen}>Abrir</button></td>
    </tr>
  );
}

function Company({ tenant, month, me, version, run }: { tenant: any; month: string; me: any; version: number; run: (w: () => Promise<unknown>) => void }) {
  const base = `/tenants/${tenant.id}`;
  const closing = useApi<any>(`${base}/closing?month=${month}`, version);
  const accounts = useApi<any[]>(`${base}/balance-validations`, version);
  const approvals = useApi<any[]>(`${base}/approvals`, version);
  const issues = useApi<any[]>(`${base}/issues`, version);
  const report = useApi<any>(`${base}/reports?month=${month}`, version);
  const closed = closing && ["CLOSED_PUBLISHED", "CLOSED_WITH_CAVEATS"].includes(closing.status);

  function caveats(e: FormEvent<HTMLFormElement>) {
    const d = field(e);
    run(() => api(`${base}/closing`, { body: { month, caveats: {
      justification: String(d.get("justification")), reviewDeadline: String(d.get("deadline")), responsibleUserId: me.userId,
      issueIds: closing.checklist.blockingIssues.map((i: any) => i.id) } } }));
  }
  function reopen(e: FormEvent<HTMLFormElement>) {
    const d = field(e);
    run(() => api(`${base}/closing/reopen`, { body: { month, reason: String(d.get("reason")) } }));
  }
  function routine(e: FormEvent<HTMLFormElement>) {
    const d = field(e);
    run(() => api(`${base}/routines`, { body: { title: String(d.get("title")), frequency: String(d.get("frequency")),
      expectedSourceType: String(d.get("source")), dueDayOffset: Number(d.get("offset")) } }));
  }
  function issueAction(e: FormEvent<HTMLFormElement>, issue: any) {
    const reason = String(field(e).get("reason"));
    run(() => issue.status === "ANSWERED_PENDING_BPO_VALIDATION" || issue.status === "WAITING_BPO_ACTION"
      ? api(`${base}/issues/${issue.id}/validate`, { body: { decision: "ACCEPT", reason } })
      : api(`${base}/issues/${issue.id}/reopen`, { body: { reason } }));
  }

  if (!closing) return <section><p>Carregando {tenant.trade_name}… (o Master BPO precisa de um acesso de suporte ativo)</p></section>;
  return (
    <>
      <section>
        <h2>{tenant.trade_name} — fechamento <Badge code={closing.status} /></h2>
        <table><tbody>{closing.checklist.items.map((i: any) => (
          <tr key={i.code}>
            <td><span className={`badge ${i.ok ? "ok" : "bad"}`}>{i.ok ? "OK" : "Impede"}</span></td>
            <td>{i.label}</td><td>{i.detail}</td>
          </tr>
        ))}</tbody></table>
        {!closed && (
          <>
            <form onSubmit={(e) => { e.preventDefault(); run(() => api(`${base}/closing`, { body: { month } })); }}>
              <button disabled={!closing.checklist.ready}>Publicar fechamento</button>
            </form>
            {!closing.checklist.ready && closing.checklist.blockingIssues.length > 0 && (
              <form onSubmit={caveats}>
                <label>Justificativa da ressalva <input name="justification" minLength={20} required size={50} /></label>
                <label>Revisar até <input name="deadline" type="date" required /></label>
                <button>Publicar com ressalva ({closing.checklist.blockingIssues.length} pendência(s))</button>
              </form>
            )}
          </>
        )}
        {closed && (
          <form onSubmit={reopen}>
            <label>Motivo da reabertura <input name="reason" minLength={10} required size={50} /></label>
            <button>Reabrir</button>
          </form>
        )}
        {closing.versions.map((v: any) => (
          <p key={v.id}>Versão {v.version_number} <Badge code={v.closing_type} /> {v.status === "ACTIVE" ? "vigente" : "substituída"} · {day(v.published_at)}</p>
        ))}
      </section>

      {!!approvals?.length && (
        <section>
          <h2>Aguardando segunda aprovação</h2>
          <table><tbody>{approvals.map((a) => (
            <tr key={a.id}>
              <td>{ACTION[a.action]}</td><td>{a.payload.reason ?? a.payload.caveats?.justification} {a.payload.amount && brl(a.payload.amount)}</td>
              <td>{a.requested_by}</td>
              <td>
                {a.requested_by_user_id !== me.userId &&
                  <button onClick={() => run(() => api(`${base}/approvals/${a.id}`, { body: { decision: "APPROVE" } }))}>Aprovar</button>}{" "}
                <button onClick={() => run(() => api(`${base}/approvals/${a.id}`, { body: { decision: "REJECT" } }))}>Recusar</button>
              </td>
            </tr>
          ))}</tbody></table>
        </section>
      )}

      {!!issues?.length && (
        <section>
          <h2>Pendências</h2>
          <table><tbody>{issues.map((i) => (
            <tr key={i.id}>
              <td>{i.title}<br /><small>{i.client_response_text}</small></td><td>{i.status === "WAITING_CLIENT_RESPONSE" ? <span className="badge warn">Aguardando o cliente</span> : <Badge code={i.status} />}</td>
              <td>{["ANSWERED_PENDING_BPO_VALIDATION", "WAITING_BPO_ACTION", "RESOLVED", "ACCEPTED_WITH_CAVEAT"].includes(i.status) && (
                <form onSubmit={(e) => issueAction(e, i)}>
                  <input name="reason" aria-label="Motivo" placeholder="Motivo" minLength={10} required />
                  <button>{["RESOLVED", "ACCEPTED_WITH_CAVEAT"].includes(i.status) ? "Reabrir" : "Aceitar"}</button>
                </form>
              )}</td>
            </tr>
          ))}</tbody></table>
        </section>
      )}

      {!!accounts?.length && (
        <section>
          <h2>Saldos iniciais</h2>
          <table><tbody>{accounts.map((a) => (
            <tr key={a.id}>
              <td>{a.name}</td><td className="num">{brl(a.initial_balance)}</td><td>em {day(a.initial_balance_date)}</td>
              <td>{a.balance_validated_at ? <span className="badge ok">Validado</span>
                : <button onClick={() => run(() => api(`${base}/balance-validations/${a.id}`, { method: "POST" }))}>Validar</button>}</td>
            </tr>
          ))}</tbody></table>
        </section>
      )}

      <section>
        <h2>Rotina do cliente</h2>
        <button onClick={() => run(() => api(`${base}/routines?month=${month}`, { method: "PUT" }))}>Gerar itens do mês</button>
        {me.isBpoMaster && (
          <form onSubmit={routine}>
            <label>Título <input name="title" required minLength={3} /></label>
            <label>Frequência <select name="frequency" defaultValue="MONTHLY">
              <option value="DAILY">Diária</option><option value="WEEKLY">Semanal</option><option value="BIWEEKLY">Quinzenal</option><option value="MONTHLY">Mensal</option>
            </select></label>
            <label>Documento <select name="source">
              <option value="BANK_STATEMENT">Extrato</option><option value="ACQUIRER_REPORT">Maquininha</option>
              <option value="CASH_SUMMARY">Resumo de caixa</option><option value="EXPENSE_RECEIPTS">Comprovantes</option>
            </select></label>
            <label>Prazo (dias após o período) <input name="offset" type="number" min={0} max={60} defaultValue={1} /></label>
            <button>Criar rotina</button>
          </form>
        )}
      </section>

      {report && <section><h2>Prévia interna (não publicada)</h2><Report data={report} /></section>}
    </>
  );
}

export default function Painel() {
  const me = useApi<any>("/me");
  const tenants = useApi<any[]>("/tenants");
  const [month, setMonth] = useState(thisMonth);
  const [selected, setSelected] = useState<any>(null);
  const { error, version, run } = useAction();
  useEffect(() => { if (tenants?.length === 1) setSelected(tenants[0]); }, [tenants]);

  function support(e: FormEvent<HTMLFormElement>) {
    const reason = String(field(e).get("reason"));
    run(() => api("/support-sessions", { body: { tenantId: selected.id, reason } }));
  }

  return (
    <Shell title="Painel operacional do BPO" nav={[{ href: "/painel", label: "Painel", current: true }, { href: "/cadastros", label: "Cadastros" }]}>
      <form onSubmit={(e) => e.preventDefault()}>
        <label>Competência <input type="month" value={month} onChange={(e) => setMonth(e.target.value || thisMonth())} /></label>
      </form>
      <p role="alert">{error}</p>
      <section>
        <h2>Carteira</h2>
        <table>
          <thead><tr><th>Empresa</th><th>Fechamento</th><th>Pendências abertas</th><th>Entregas atrasadas</th><th></th></tr></thead>
          <tbody>{tenants?.map((t) => <PortfolioRow key={t.id} tenant={t} month={month} version={version} onOpen={() => setSelected(t)} />)}</tbody>
        </table>
      </section>
      {selected && me?.isBpoMaster && (
        <form onSubmit={support}>
          <label>Acesso de suporte a {selected.trade_name} (60 min) <input name="reason" required minLength={10} placeholder="Motivo" size={40} /></label>
          <button>Iniciar</button>
        </form>
      )}
      {selected && me && <Company key={selected.id} tenant={selected} month={month} me={me} version={version} run={run} />}
    </Shell>
  );
}
