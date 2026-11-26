"use client";
import { useEffect, useState, type FormEvent } from "react";
import { api, Badge, day, field, Report, Shell, thisMonth, useAction, useApi } from "../_ui/shared";

/* eslint-disable @typescript-eslint/no-explicit-any */
const CATEGORY: Record<string, string> = {
  BANK_STATEMENT: "Extrato bancário", ACQUIRER_REPORT: "Relatório da maquininha", RECEIPT: "Comprovante de despesa",
  CASH_SUMMARY: "Resumo de caixa", INVOICE_NFE: "Nota fiscal", BOLETO: "Boleto", OTHER: "Outro",
};
const BY_SOURCE: Record<string, string> = { EXPENSE_RECEIPTS: "RECEIPT" };

function upload(tenant: string, file: File, data: object) {
  const form = new FormData();
  form.set("file", file);
  form.set("data", JSON.stringify(data));
  return api<{ id: string; receiptStatus: string }>(`/tenants/${tenant}/documents`, { form });
}

export default function Portal() {
  const tenants = useApi<any[]>("/tenants");
  const [tenant, setTenant] = useState("");
  const [month, setMonth] = useState(thisMonth);
  const [open, setOpen] = useState("");
  const { error, version, run } = useAction();
  useEffect(() => { if (tenants?.[0]) setTenant((t) => t || tenants[0].id); }, [tenants]);

  const base = tenant ? `/tenants/${tenant}` : null;
  const items = useApi<any[]>(base && `${base}/routine-items?month=${month}`, version);
  const issues = useApi<any[]>(base && `${base}/issues`, version);
  const versions = useApi<any[]>(base && `${base}/closing-versions`, version);
  const report = useApi<any>(base && open ? `${base}/closing-versions/${open}` : null);

  const me = useApi<any>("/me");
  const accounts = useApi<any[]>(base && `${base}/accounts`);
  const acquirers = useApi<any[]>(base && `${base}/acquirers`);
  const units = useApi<any[]>(base && `${base}/business-units`);
  const [account, setAccount] = useState("");
  const [acquirer, setAcquirer] = useState("");
  const [unit, setUnit] = useState("");
  const [sent, setSent] = useState("");
  useEffect(() => { setAccount(""); setAcquirer(""); setUnit(""); }, [tenant]);
  const employee = me?.memberships.some((m: any) => m.tenantId === tenant && m.role === "CLIENT_EMPLOYEE");

  const send = (file: File, category: string, itemId?: string) => run(async () => {
    setSent("");
    const data: Record<string, string> = { docCategory: category, competenceDate: `${month}-01` };
    if (category === "BANK_STATEMENT") {
      const id = account || accounts?.[0]?.id;
      if (id) data.financialAccountId = id;
    }
    if (category === "ACQUIRER_REPORT") {
      const id = acquirer || acquirers?.[0]?.id;
      if (id) data.acquirerId = id;
    }
    // Funcionário envia sempre dentro de uma unidade do seu escopo.
    const unitId = unit || (employee ? units?.[0]?.id : "");
    if (unitId) data.businessUnitId = unitId;
    const result = await upload(tenant, file, data);
    if (result.receiptStatus === "REJECTED_INVALID") throw new Error("ARQUIVO_RECUSADO");
    if (itemId) await api(`${base}/routine-items/${itemId}`, { body: { action: "SUBMIT", documentId: result.id } });
    setSent(`Arquivo "${file.name}" recebido.`);
  });
  const select = (label: string, list: any[] | null, value: string, set: (v: string) => void, empty?: string) =>
    !!list?.length && (empty !== undefined || list.length > 1) && (
      <label>{label}
        <select value={value} onChange={(e) => set(e.target.value)}>
          {empty !== undefined && <option value="">{empty}</option>}
          {list.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
        </select>
      </label>
    );

  function quick(e: FormEvent<HTMLFormElement>) {
    const form = e.currentTarget;
    const data = field(e);
    send(data.get("file") as File, String(data.get("category"))).then(() => form.reset());
  }
  function respond(e: FormEvent<HTMLFormElement>, id: string) {
    const data = field(e);
    run(() => api(`${base}/issues/${id}/respond`, { body: { text: String(data.get("text")) } }));
  }

  const mine = issues?.filter((i) => !["RESOLVED", "ACCEPTED_WITH_CAVEAT"].includes(i.status));
  return (
    <Shell title="Portal do cliente">
      <form onSubmit={(e) => e.preventDefault()}>
        {tenants && tenants.length > 1 && (
          <label>Empresa
            <select value={tenant} onChange={(e) => { setTenant(e.target.value); setOpen(""); }}>
              {tenants.map((t) => <option key={t.id} value={t.id}>{t.trade_name}</option>)}
            </select>
          </label>
        )}
        <label>Mês <input type="month" value={month} onChange={(e) => setMonth(e.target.value || thisMonth())} /></label>
      </form>
      <p role="alert">{error}</p>
      <p role="status">{sent}</p>
      <form onSubmit={(e) => e.preventDefault()}>
        {select("Conta do extrato", accounts, account, setAccount)}
        {select("Maquininha do relatório", acquirers, acquirer, setAcquirer)}
        {select("Unidade", units, unit, setUnit, employee ? undefined : "Toda a empresa")}
      </form>

      <section>
        <h2>Minha rotina</h2>
        {!items?.length ? <p>Nada previsto para este mês.</p> : (
          <table className="rotina"><tbody>{items.map((i) => (
            <tr key={i.id}>
              <td>{i.title}</td><td>até {day(i.due_date)}</td><td><Badge code={i.status} /></td>
              <td>{["PENDING", "OVERDUE"].includes(i.status) &&
                <input type="file" aria-label={`Enviar arquivo: ${i.title}`}
                  onChange={(e) => e.target.files?.[0] && send(e.target.files[0], BY_SOURCE[i.expected_source_type] ?? i.expected_source_type, i.id)} />}</td>
            </tr>
          ))}</tbody></table>
        )}
      </section>

      <section>
        <h2>Envio rápido</h2>
        <form onSubmit={quick}>
          <label>Tipo
            <select name="category" defaultValue="RECEIPT">
              {Object.entries(CATEGORY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
          <label>Arquivo <input name="file" type="file" required /></label>
          <button>Enviar</button>
        </form>
      </section>

      <section>
        <h2>Pendências</h2>
        {!mine?.length ? <p>Nenhuma pendência em aberto.</p> : mine.map((i) => (
          <article key={i.id}>
            <p><strong>{i.title}</strong> <Badge code={i.status} /><br />{i.description}</p>
            {i.status === "WAITING_CLIENT_RESPONSE" && (
              <form onSubmit={(e) => respond(e, i.id)}>
                <label>Resposta <input name="text" required minLength={3} /></label>
                <button>Responder</button>
              </form>
            )}
          </article>
        ))}
      </section>

      {versions && (
        <section>
          <h2>Relatórios liberados</h2>
          {!versions.length ? <p>Nenhum fechamento publicado ainda.</p> : (
            <table><tbody>{versions.map((v) => (
              <tr key={v.id}>
                <td>{v.month.split("-").reverse().join("/")}</td><td>versão {v.version_number}</td>
                <td><Badge code={v.closing_type} /></td><td><button onClick={() => setOpen(v.id)}>Ver</button></td>
              </tr>
            ))}</tbody></table>
          )}
          {report && (
            <>
              {report.caveat_justification && <p className="badge warn">Ressalva: {report.caveat_justification}</p>}
              <Report data={report.snapshot} />
            </>
          )}
        </section>
      )}
    </Shell>
  );
}
