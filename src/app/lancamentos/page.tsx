"use client";
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { addMonths } from "../../shared/dates/months";
import { api, bpoNav, brl, day, field, Shell, useAction, useApi } from "../_ui/shared";

/* eslint-disable @typescript-eslint/no-explicit-any */
const TYPE: Record<string, string> = { SALE: "Venda", SERVICE: "Serviço", PURCHASE: "Compra", EXPENSE: "Despesa", REFUND_REVERSAL: "Estorno" };
const INCOME = ["SALE", "SERVICE"];
const STATUS: Record<string, [string, string]> = {
  DRAFT: ["Rascunho", ""], SUBMITTED_PENDING_BPO: ["Aguardando aprovação", "warn"], UNDER_BPO_REVIEW: ["Em revisão", "warn"],
  APPROVED_FOR_LEDGER: ["Aprovado", "ok"], RETURNED_FOR_CORRECTION: ["Devolvido", "bad"], REJECTED: ["Rejeitado", "bad"], LOCKED_IN_CLOSING: ["Fechado", ""],
};
const CASH: Record<string, string> = {
  CASH_EXPENSE: "Despesa em dinheiro", DAILY_SALES_SUMMARY: "Resumo de vendas do dia", DECLARED_PAYMENT: "Pagamento declarado", DECLARED_RECEIPT: "Recebimento declarado",
};

function useList<T = any>(path: string | null, version: number) {
  const [data, setData] = useState<T[] | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    setData(undefined);
    if (path) api<T[]>(path).then((d) => live && setData(Array.isArray(d) ? d : null), () => live && setData(null));
    return () => { live = false; };
  }, [path, version]);
  return data;
}

function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  return (
    <div className="cad-overlay" onClick={onClose}>
      <div className="cad-sheet" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="cad-sheet-head"><h2>{title}</h2><button className="cad-x" onClick={onClose} aria-label="Fechar">×</button></div>
        {children}
      </div>
    </div>
  );
}

const Field = ({ label, children }: { label: string; children: ReactNode }) => <label className="cad-field"><span>{label}</span>{children}</label>;

export default function Lancamentos() {
  const me = useApi<any>("/me");
  const tenants = useApi<any[]>("/tenants");
  const [tenantId, setTenantId] = useState("");
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<"ALL" | "PENDING">("ALL");
  const [picked, setPicked] = useState<string[]>([]);
  const [kind, setKind] = useState("SALE");
  const [done, setDone] = useState("");
  const { error, version, run } = useAction();

  useEffect(() => { if (!tenantId && tenants?.length === 1) setTenantId(tenants[0].id); }, [tenants, tenantId]);
  const base = `/tenants/${tenantId}`;
  const entries = useList(tenantId ? `${base}/entries` : null, version);
  const categories = useList(tenantId ? `${base}/categories` : null, version);
  const centers = useList(tenantId ? `${base}/cost-centers` : null, version);
  const tags = useList(tenantId ? `${base}/tags` : null, version);
  const units = useList(tenantId ? `${base}/business-units` : null, version);
  useEffect(() => { if (!done) return; const t = setTimeout(() => setDone(""), 3500); return () => clearTimeout(t); }, [done]);

  const tagOf = useMemo(() => new Map((tags ?? []).map((t: any) => [t.id, t])), [tags]);
  const categoryOf = useMemo(() => new Map((categories ?? []).map((c: any) => [c.id, c])), [categories]);
  const rows = (entries ?? []).filter((r: any) => filter === "ALL" || ["SUBMITTED_PENDING_BPO", "UNDER_BPO_REVIEW"].includes(r.review_status));
  const pending = (entries ?? []).filter((r: any) => r.kind === "OPERATION" && ["SUBMITTED_PENDING_BPO", "UNDER_BPO_REVIEW"].includes(r.review_status));
  const noAccess = !!tenantId && entries === null;
  const isMaster = !!me?.isBpoMaster;

  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const approve = () => run(async () => {
    await api(`${base}/operations/approve`, { body: { operationIds: picked } });
    setPicked([]); setDone("Lançamentos aprovados.");
  });

  const save = useCallback((e: FormEvent<HTMLFormElement>) => {
    const d = field(e);
    const n = Math.max(1, Math.min(99, Number(d.get("parts") || 1)));
    const first = String(d.get("due"));
    const optional = (k: string) => String(d.get(k) || "") || undefined;
    run(async () => {
      await api(`${base}/operations`, { body: {
        operationType: kind, operationDate: String(d.get("date")), competenceDate: optional("competence"),
        grossAmount: String(d.get("amount")).replace(/\./g, "").replace(",", "."), description: String(d.get("description")),
        counterpartyName: optional("who"), businessUnitId: optional("unit"), categoryId: optional("category"),
        costCenterId: optional("center"), tagId: optional("tag"),
        installments: Array.from({ length: n }, (_, i) => ({ dueDate: addMonths(first, i) })) } });
      setOpen(false); setDone("Lançamento registrado. Falta aprovar para entrar nos relatórios.");
    });
  }, [base, kind, run]);

  const categoryOptions = (categories ?? []).filter((c: any) => c.is_active)
    .filter((c: any) => INCOME.includes(kind) ? c.nature === "REVENUE" : c.nature !== "REVENUE");
  const today = new Date().toISOString().slice(0, 10);

  return (
    <Shell title="Lançamentos" nav={bpoNav("lancamentos")}>
      <div className="cad">
        <div className="cad-top">
          <label className="cad-field cad-tenant"><span>Empresa</span>
            <select value={tenantId} onChange={(e) => { setTenantId(e.target.value); setPicked([]); }}>
              <option value="">{tenants ? "Escolha a empresa" : "Carregando…"}</option>
              {(tenants ?? []).map((t) => <option key={t.id} value={t.id}>{t.trade_name}</option>)}
            </select></label>
          {tenantId && !noAccess && <button className="cad-primary" onClick={() => setOpen(true)}>+ Novo lançamento</button>}
        </div>
        <div role="alert" aria-live="polite">{error}</div>
        {done && <div className="cad-toast" role="status">{done}</div>}

        {!tenantId && <div className="cad-empty"><p>Escolha uma empresa para ver e registrar lançamentos.</p></div>}
        {noAccess && <div className="cad-empty"><p>{isMaster ? "Abra o acesso de suporte desta empresa no Painel ou em Cadastros." : "Você não tem acesso aos lançamentos desta empresa."}</p></div>}

        {tenantId && !noAccess && (
          <section className="cad-panel">
            <div className="cad-panel-head">
              <nav className="cad-tabs cad-filter" aria-label="Filtro">
                <button className={filter === "ALL" ? "on" : ""} onClick={() => setFilter("ALL")}>Todos</button>
                <button className={filter === "PENDING" ? "on" : ""} onClick={() => setFilter("PENDING")}>A aprovar ({pending.length})</button>
              </nav>
              {!!picked.length && <button className="cad-primary" onClick={approve}>Aprovar {picked.length}</button>}
            </div>
            {entries === undefined ? <p className="cad-muted">Carregando…</p> : !rows.length ? (
              <div className="cad-empty"><p>{filter === "PENDING" ? "Nada aguardando aprovação." : "Nenhum lançamento ainda."}</p></div>
            ) : (
              <ul className="cad-list cad-one">{rows.map((r: any) => {
                const [label, tone] = STATUS[r.review_status] ?? [r.review_status, ""];
                const tag = r.tag_id ? tagOf.get(r.tag_id) : null;
                const cat = r.category_id ? categoryOf.get(r.category_id) : null;
                const income = r.kind === "OPERATION" ? INCOME.includes(r.operation_type) : r.entry_type?.includes("SALES") || r.entry_type === "DECLARED_RECEIPT";
                const canPick = r.kind === "OPERATION" && ["SUBMITTED_PENDING_BPO", "UNDER_BPO_REVIEW"].includes(r.review_status);
                return (
                  <li key={r.id} className="cad-item">
                    {canPick && <input type="checkbox" aria-label="Selecionar para aprovar" checked={picked.includes(r.id)} onChange={() => toggle(r.id)} className="cad-pick" />}
                    <div className="cad-item-main">
                      <strong>{r.description}</strong>
                      <span>{day(r.date)} · {r.kind === "OPERATION" ? TYPE[r.operation_type] : CASH[r.entry_type] ?? "Caixa"}{cat ? ` · ${cat.code} ${cat.name}` : ""}</span>
                      {tag && <span className="cad-chip"><i style={{ background: tag.color ?? "#9aa6b5" }} />{tag.name}</span>}
                    </div>
                    <div className="cad-amount"><strong className={income ? "in" : "out"}>{income ? "+" : "−"} {brl(r.amount)}</strong><span className={`badge ${tone}`}>{label}</span></div>
                  </li>);
              })}</ul>
            )}
            {!!pending.length && <p className="cad-hint">Aprovar exige perfil de Revisor ou Master. Só lançamentos aprovados entram nos relatórios.</p>}
          </section>
        )}
      </div>

      {open && (
        <Sheet title="Novo lançamento" onClose={() => setOpen(false)}>
          <form className="cad-form" onSubmit={save}>
            <fieldset className="cad-seg"><legend>Tipo</legend>
              {Object.entries(TYPE).filter(([k]) => k !== "REFUND_REVERSAL").map(([k, v]) => (
                <label key={k} className={kind === k ? "on" : ""}><input type="radio" name="kind" checked={kind === k} onChange={() => setKind(k)} />{v}</label>))}
            </fieldset>
            <Field label="Descrição"><input name="description" required minLength={3} maxLength={300} autoFocus placeholder={INCOME.includes(kind) ? "Ex.: Mensalidade – Maria" : "Ex.: Aluguel de novembro"} /></Field>
            <Field label={INCOME.includes(kind) ? "Cliente (opcional)" : "Fornecedor (opcional)"}><input name="who" maxLength={180} /></Field>
            <div className="cad-row">
              <Field label="Valor total (R$)"><input name="amount" required inputMode="decimal" placeholder="0,00" pattern="[0-9.]+(,[0-9]{1,2})?" /></Field>
              <Field label="Data da operação"><input name="date" type="date" required defaultValue={today} /></Field>
            </div>
            <div className="cad-row">
              <Field label="1º vencimento"><input name="due" type="date" required defaultValue={today} /></Field>
              <Field label="Parcelas (mensais)"><input name="parts" type="number" min={1} max={99} defaultValue={1} inputMode="numeric" /></Field>
            </div>
            <Field label="Competência (opcional)"><input name="competence" type="date" /></Field>
            {!!categoryOptions.length && <Field label="Categoria"><select name="category" defaultValue=""><option value="">Sem categoria</option>
              {categoryOptions.map((c: any) => <option key={c.id} value={c.id}>{c.code} {c.name}</option>)}</select></Field>}
            {!!tags?.filter((t: any) => t.is_active).length && <Field label="Etiqueta do contrato"><select name="tag" defaultValue=""><option value="">Sem etiqueta</option>
              {tags.filter((t: any) => t.is_active).map((t: any) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Field>}
            {!!centers?.filter((t: any) => t.is_active).length && <Field label="Centro de custo"><select name="center" defaultValue=""><option value="">Nenhum</option>
              {centers.filter((t: any) => t.is_active).map((t: any) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Field>}
            {!!units?.length && <Field label="Unidade"><select name="unit" defaultValue=""><option value="">Todas</option>
              {units.map((u: any) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></Field>}
            <p className="cad-hint">Parcelas dividem o valor igualmente, uma por mês a partir do 1º vencimento. O lançamento fica aguardando aprovação.</p>
            <button className="cad-primary cad-block">Registrar</button>
          </form>
        </Sheet>
      )}
    </Shell>
  );
}
