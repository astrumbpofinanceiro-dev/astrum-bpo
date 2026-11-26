"use client";
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { api, field, Shell, useAction, useApi } from "../_ui/shared";

/* eslint-disable @typescript-eslint/no-explicit-any */
const TABS = [
  ["unidades", "Unidades"], ["contas", "Contas"], ["cartoes", "Cartões"],
  ["adquirentes", "Adquirentes"], ["plano", "Plano de contas"], ["centros", "Centros de custo"],
] as const;
type Tab = (typeof TABS)[number][0];

const ACCOUNT_TYPE: Record<string, string> = { BANK_CHECKING: "Conta corrente", CASH_PHYSICAL: "Caixa físico", CORPORATE_CARD: "Cartão corporativo" };
const NATURE: Record<string, string> = {
  REVENUE: "Receita", DIRECT_COST: "Custo direto", FIXED_EXPENSE: "Despesa fixa", VARIABLE_EXPENSE: "Despesa variável",
  FINANCIAL_EXPENSE: "Despesa financeira", PARTNER_DRAW: "Retirada de sócio", CAPITAL_CONTRIBUTION: "Aporte de capital",
};
const SEGMENT: Record<string, string> = { FOOD_SERVICE: "Alimentação", RETAIL: "Varejo", SERVICES: "Serviços" };

/** undefined = carregando; null = sem permissão ou sem acesso. */
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

const Empty = ({ text, action }: { text: string; action?: ReactNode }) => (
  <div className="cad-empty"><p>{text}</p>{action}</div>
);

function Item({ title, meta, badge, actions }: { title: string; meta?: ReactNode; badge?: ReactNode; actions?: ReactNode }) {
  return (
    <li className="cad-item">
      <div className="cad-item-main"><strong>{title}</strong>{meta && <span>{meta}</span>}</div>
      {badge}{actions}
    </li>
  );
}

export default function Cadastros() {
  const me = useApi<any>("/me");
  const tenants = useApi<any[]>("/tenants");
  const [tenantId, setTenantId] = useState("");
  const [tab, setTab] = useState<Tab>("unidades");
  const [sheet, setSheet] = useState<null | "tenant" | "form">(null);
  const { error, version, run } = useAction();
  const [done, setDone] = useState("");

  useEffect(() => { if (!tenantId && tenants?.length === 1) setTenantId(tenants[0].id); }, [tenants, tenantId]);
  const tenant = tenants?.find((t) => t.id === tenantId);
  const base = `/tenants/${tenantId}`;
  const isMaster = !!me?.isBpoMaster;

  const units = useList(tenantId ? `${base}/business-units` : null, version);
  const accounts = useList(tenantId ? `${base}/accounts` : null, version);
  const acquirers = useList(tenantId ? `${base}/acquirers` : null, version);
  const categories = useList(tenantId ? `${base}/categories` : null, version);
  const centers = useList(tenantId ? `${base}/cost-centers` : null, version);
  const noAccess = !!tenantId && units === null && accounts === null;

  const save = useCallback((work: () => Promise<unknown>, message: string) => {
    run(async () => { await work(); setSheet(null); setDone(message); });
  }, [run]);
  useEffect(() => { if (!done) return; const t = setTimeout(() => setDone(""), 3500); return () => clearTimeout(t); }, [done]);

  const banks = (accounts ?? []).filter((a: any) => a.account_type !== "CORPORATE_CARD");
  const cards = (accounts ?? []).filter((a: any) => a.account_type === "CORPORATE_CARD");
  const unitName = (id: string | null) => units?.find((u: any) => u.id === id)?.name ?? "Todas as unidades";
  const tree = useMemo(() => {
    const list: any[] = categories ?? [];
    const byParent = Map.groupBy(list, (c) => c.parent_id ?? "");
    const out: { c: any; depth: number }[] = [];
    const walk = (parent: string, depth: number) => (byParent.get(parent) ?? []).forEach((c) => { out.push({ c, depth }); walk(c.id, depth + 1); });
    walk("", 0);
    return out;
  }, [categories]);

  // ---- formulários -------------------------------------------------------
  const unitForm = (e: FormEvent<HTMLFormElement>) => { const d = field(e);
    save(() => api(`${base}/business-units`, { body: { name: String(d.get("name")), code: String(d.get("code") || "") || null } }), "Unidade cadastrada."); };
  const accountForm = (card: boolean) => (e: FormEvent<HTMLFormElement>) => { const d = field(e);
    save(() => api(`${base}/accounts`, { body: {
      name: String(d.get("name")), accountType: card ? "CORPORATE_CARD" : String(d.get("type")),
      businessUnitId: String(d.get("unit") || "") || null, bankCode: String(d.get("bank") || "") || null,
      initialBalance: String(d.get("balance") || "0").replace(",", "."), initialBalanceDate: String(d.get("date")) } }),
      card ? "Cartão cadastrado." : "Conta cadastrada."); };
  const acquirerForm = (e: FormEvent<HTMLFormElement>) => { const d = field(e);
    save(() => api(`${base}/acquirers`, { body: { name: String(d.get("name")), settlementAccountId: String(d.get("account")) } }), "Adquirente cadastrada."); };
  const categoryForm = (e: FormEvent<HTMLFormElement>) => { const d = field(e);
    save(() => api(`${base}/categories`, { body: { code: String(d.get("code")), name: String(d.get("name")),
      nature: String(d.get("nature")), parentId: String(d.get("parent") || "") || null } }), "Categoria cadastrada."); };
  const centerForm = (e: FormEvent<HTMLFormElement>) => { const d = field(e);
    save(() => api(`${base}/cost-centers`, { body: { name: String(d.get("name")) } }), "Centro de custo cadastrado."); };
  const tenantForm = (e: FormEvent<HTMLFormElement>) => { const d = field(e);
    run(async () => {
      const r = await api<{ id: string }>("/tenants", { body: { legalName: String(d.get("legal")), tradeName: String(d.get("trade")),
        taxId: String(d.get("tax")).replace(/[^0-9A-Za-z]/g, "").toUpperCase(), segmentCode: String(d.get("segment")) } });
      setSheet(null); setDone("Empresa cadastrada. Abra o acesso de suporte para cadastrar a estrutura."); setTenantId(r.id);
    }); };
  const supportForm = (e: FormEvent<HTMLFormElement>) => { const d = field(e);
    run(() => api("/support-sessions", { body: { tenantId, reason: String(d.get("reason")) } })); };
  const toggle = (path: string, row: any, label: string) =>
    run(async () => { await api(path, { method: "PATCH", body: { isActive: !row.is_active } }); setDone(label); });

  const Add = ({ label }: { label: string }) => <button className="cad-primary" onClick={() => setSheet("form")}>+ {label}</button>;
  const Field = ({ label, children }: { label: string; children: ReactNode }) => <label className="cad-field"><span>{label}</span>{children}</label>;
  const Submit = ({ children }: { children: string }) => <button className="cad-primary cad-block">{children}</button>;
  const unitSelect = (
    <Field label="Unidade (opcional)">
      <select name="unit" defaultValue=""><option value="">Todas as unidades</option>
        {(units ?? []).map((u: any) => <option key={u.id} value={u.id}>{u.name}</option>)}</select>
    </Field>
  );
  const accountFields = (card: boolean) => (
    <form className="cad-form" onSubmit={accountForm(card)}>
      <Field label={card ? "Nome do cartão" : "Nome da conta"}><input name="name" required maxLength={120} autoFocus placeholder={card ? "Ex.: Visa Empresarial" : "Ex.: Banco do Brasil – 1234"} /></Field>
      {!card && <Field label="Tipo"><select name="type" defaultValue="BANK_CHECKING">
        <option value="BANK_CHECKING">Conta corrente</option><option value="CASH_PHYSICAL">Caixa físico</option></select></Field>}
      {!card && <Field label="Código do banco (opcional)"><input name="bank" maxLength={10} inputMode="numeric" placeholder="001" /></Field>}
      {unitSelect}
      <div className="cad-row">
        <Field label={card ? "Saldo inicial" : "Saldo inicial (R$)"}><input name="balance" inputMode="decimal" pattern="-?[0-9]+([.,][0-9]{1,2})?" defaultValue="0,00" required /></Field>
        <Field label="Data do saldo"><input name="date" type="date" required defaultValue={new Date().toISOString().slice(0, 7) + "-01"} /></Field>
      </div>
      <Submit>Salvar</Submit>
    </form>
  );

  const forms: Record<Tab, { title: string; add: string; body: ReactNode }> = {
    unidades: { title: "Nova unidade", add: "Unidade", body: (
      <form className="cad-form" onSubmit={unitForm}>
        <Field label="Nome"><input name="name" required maxLength={120} autoFocus placeholder="Ex.: Loja Centro" /></Field>
        <Field label="Código (opcional)"><input name="code" maxLength={30} /></Field><Submit>Salvar</Submit>
      </form>) },
    contas: { title: "Nova conta", add: "Conta", body: accountFields(false) },
    cartoes: { title: "Novo cartão", add: "Cartão", body: accountFields(true) },
    adquirentes: { title: "Nova adquirente", add: "Adquirente", body: (
      <form className="cad-form" onSubmit={acquirerForm}>
        <Field label="Nome"><input name="name" required maxLength={80} autoFocus placeholder="Ex.: Cielo" /></Field>
        <Field label="Conta onde o repasse cai"><select name="account" required defaultValue="">
          <option value="" disabled>Escolha a conta</option>{banks.map((a: any) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
        <Submit>Salvar</Submit>
      </form>) },
    plano: { title: "Nova categoria", add: "Categoria", body: (
      <form className="cad-form" onSubmit={categoryForm}>
        <div className="cad-row">
          <Field label="Código"><input name="code" required maxLength={30} autoFocus placeholder="1.1" /></Field>
          <Field label="Natureza"><select name="nature" required defaultValue="">
            <option value="" disabled>Escolha</option>{Object.entries(NATURE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        </div>
        <Field label="Nome"><input name="name" required maxLength={120} placeholder="Ex.: Vendas no salão" /></Field>
        <Field label="Dentro de (opcional)"><select name="parent" defaultValue=""><option value="">Nível principal</option>
          {tree.map(({ c, depth }) => <option key={c.id} value={c.id}>{"– ".repeat(depth)}{c.code} {c.name}</option>)}</select></Field>
        <p className="cad-hint">Depois de criados, código, natureza e posição não mudam: lançamentos antigos dependem deles. Só o nome e a situação.</p>
        <Submit>Salvar</Submit>
      </form>) },
    centros: { title: "Novo centro de custo", add: "Centro de custo", body: (
      <form className="cad-form" onSubmit={centerForm}>
        <Field label="Nome"><input name="name" required maxLength={100} autoFocus placeholder="Ex.: Cozinha" /></Field><Submit>Salvar</Submit>
      </form>) },
  };

  const loading = <p className="cad-muted">Carregando…</p>;
  const denied = <Empty text="Você não tem acesso a esta lista." />;
  const gate = (data: any[] | null | undefined, render: (rows: any[]) => ReactNode) =>
    data === undefined ? loading : data === null ? denied : render(data);

  const Actions = ({ onClick, active }: { onClick: () => void; active: boolean }) =>
    isMaster ? <button className="cad-ghost" onClick={onClick}>{active ? "Desativar" : "Reativar"}</button> : null;
  const Status = ({ active }: { active: boolean }) => <span className={`badge ${active ? "ok" : ""}`}>{active ? "Ativo" : "Inativo"}</span>;
  const addButton = isMaster ? <Add label={forms[tab].add} /> : null;

  const panels: Record<Tab, ReactNode> = {
    unidades: gate(units, (rows) => rows.length ? <ul className="cad-list">{rows.map((u) =>
      <Item key={u.id} title={u.name} meta={u.code ?? "Sem código"} badge={<Status active={u.is_active} />} />)}</ul>
      : <Empty text="Nenhuma unidade ainda. Unidades separam filiais ou pontos de venda da mesma empresa." action={addButton} />),
    contas: gate(accounts, () => banks.length ? <ul className="cad-list">{banks.map((a: any) =>
      <Item key={a.id} title={a.name} meta={`${ACCOUNT_TYPE[a.account_type]} · ${unitName(a.business_unit_id)}${a.bank_code ? ` · banco ${a.bank_code}` : ""}`} badge={<Status active={a.is_active} />} />)}</ul>
      : <Empty text="Nenhuma conta ainda. Cadastre as contas correntes e o caixa físico para importar extratos." action={addButton} />),
    cartoes: gate(accounts, () => cards.length ? <ul className="cad-list">{cards.map((a: any) =>
      <Item key={a.id} title={a.name} meta={unitName(a.business_unit_id)} badge={<Status active={a.is_active} />} />)}</ul>
      : <Empty text="Nenhum cartão corporativo. A fatura é paga pelo débito na conta e conciliada com as compras." action={addButton} />),
    adquirentes: gate(acquirers, (rows) => rows.length ? <ul className="cad-list">{rows.map((q) =>
      <Item key={q.id} title={q.name} meta={`Repasse em ${accounts?.find((a: any) => a.id === q.settlement_account_id)?.name ?? "—"}`} />)}</ul>
      : <Empty text={banks.length ? "Nenhuma adquirente ainda." : "Cadastre antes uma conta para receber os repasses."} action={banks.length ? addButton : undefined} />),
    plano: gate(categories, () => tree.length ? <ul className="cad-list">{tree.map(({ c, depth }) =>
      <li key={c.id} className="cad-item" style={{ marginLeft: Math.min(depth, 5) * 14 }}>
        <div className="cad-item-main"><strong><code>{c.code}</code> {c.name}</strong><span>{NATURE[c.nature]}</span></div>
        <Status active={c.is_active} />
        <Actions active={c.is_active} onClick={() => toggle(`${base}/categories/${c.id}`, c, c.is_active ? "Categoria desativada." : "Categoria reativada.")} />
      </li>)}</ul>
      : <Empty text="Nenhuma categoria ainda. Monte o plano de contas em níveis: Receitas, Custos, Despesas…" action={addButton} />),
    centros: gate(centers, (rows) => rows.length ? <ul className="cad-list">{rows.map((c) =>
      <Item key={c.id} title={c.name} badge={<Status active={c.is_active} />}
        actions={<Actions active={c.is_active} onClick={() => toggle(`${base}/cost-centers/${c.id}`, c, c.is_active ? "Centro desativado." : "Centro reativado.")} />} />)}</ul>
      : <Empty text="Nenhum centro de custo. Use para acompanhar áreas como cozinha ou salão." action={addButton} />),
  };

  return (
    <Shell title="Cadastros" nav={[{ href: "/painel", label: "Painel" }, { href: "/cadastros", label: "Cadastros", current: true }]}>
      <div className="cad">
        <div className="cad-top">
          <label className="cad-field cad-tenant"><span>Empresa</span>
            <select value={tenantId} onChange={(e) => setTenantId(e.target.value)}>
              <option value="">{tenants ? "Escolha a empresa" : "Carregando…"}</option>
              {(tenants ?? []).map((t) => <option key={t.id} value={t.id}>{t.trade_name}</option>)}
            </select></label>
          {isMaster && <button className="cad-secondary" onClick={() => setSheet("tenant")}>+ Nova empresa</button>}
        </div>

        <div role="alert" aria-live="polite">{error}</div>
        {done && <div className="cad-toast" role="status">{done}</div>}

        {tenant && (
          <p className="cad-company"><strong>{tenant.legal_name}</strong>{tenant.segment_code && <span className="badge">{SEGMENT[tenant.segment_code]}</span>}</p>
        )}

        {!tenantId && <Empty text={tenants?.length === 0 ? "Nenhuma empresa cadastrada." : "Escolha uma empresa para ver e cadastrar a estrutura dela."}
          action={isMaster && tenants?.length === 0 ? <button className="cad-primary" onClick={() => setSheet("tenant")}>+ Nova empresa</button> : undefined} />}

        {noAccess && isMaster && (
          <form className="cad-support" onSubmit={supportForm}>
            <div><strong>Acesso de suporte necessário</strong>
              <span>Registra o motivo na auditoria e vale por 60 minutos.</span></div>
            <input name="reason" required minLength={10} placeholder="Motivo (mín. 10 letras)" aria-label="Motivo" />
            <button className="cad-primary">Abrir acesso</button>
          </form>
        )}
        {noAccess && !isMaster && <Empty text="Você não tem acesso a esta empresa." />}

        {tenantId && !noAccess && (
          <>
            <nav className="cad-tabs" aria-label="Cadastros">
              {TABS.map(([id, label]) => (
                <button key={id} className={tab === id ? "on" : ""} aria-current={tab === id ? "page" : undefined} onClick={() => setTab(id)}>{label}</button>
              ))}
            </nav>
            <section className="cad-panel">
              <div className="cad-panel-head"><h2>{TABS.find(([id]) => id === tab)![1]}</h2>{isMaster && <Add label={forms[tab].add} />}</div>
              {panels[tab]}
              {!isMaster && <p className="cad-hint">Somente o Master BPO altera a estrutura.</p>}
            </section>
          </>
        )}
      </div>

      {sheet === "form" && <Sheet title={forms[tab].title} onClose={() => setSheet(null)}>{forms[tab].body}</Sheet>}
      {sheet === "tenant" && (
        <Sheet title="Nova empresa" onClose={() => setSheet(null)}>
          <form className="cad-form" onSubmit={tenantForm}>
            <Field label="Razão social"><input name="legal" required maxLength={200} autoFocus /></Field>
            <Field label="Nome fantasia"><input name="trade" required maxLength={200} /></Field>
            <Field label="CNPJ ou CPF"><input name="tax" required inputMode="text" placeholder="Somente números ou letras" /></Field>
            <Field label="Segmento"><select name="segment" required defaultValue="">
              <option value="" disabled>Escolha</option>{Object.entries(SEGMENT).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
            <Submit>Cadastrar empresa</Submit>
          </form>
        </Sheet>
      )}
    </Shell>
  );
}
