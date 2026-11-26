/** Parsers determinísticos de OFX, CSV e XLSX. Nenhum layout de banco/adquirente é presumido. */
import { Decimal } from "decimal.js";
import { readSheet } from "read-excel-file/node";
import { z } from "zod";
import { businessDate } from "../../shared/dates/business-date";

export const MAX_ROWS = 20_000;

/** Erro do arquivo em si: repetir o processamento não muda o resultado. */
export class ParseError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/** Nome do campo (Doc 3 §1) -> título da coluna no arquivo. */
export const mappingInput = z.record(z.string().max(60), z.string().min(1).max(120));
export type Mapping = z.infer<typeof mappingInput>;

export interface BankRow {
  rowNumber: number;
  raw: Record<string, string>;
  error?: string;
  date?: string;
  direction?: "CREDIT" | "DEBIT";
  amount?: string;
  description?: string;
  fitid?: string;
}
export interface BankStatement { rows: BankRow[]; periodStart?: string; periodEnd?: string }

export interface AcquirerRow {
  rowNumber: number;
  raw: Record<string, string>;
  error?: string;
  nsu?: string;
  operationDate?: string;
  installment?: number;
  eventType?: string;
  net?: string;
  totalInstallments?: number;
  gross?: string;
  mdr?: string;
  anticipationFee?: string;
  otherFees?: string;
  expectedDate?: string;
  settlementDate?: string;
}

export function decodeText(bytes: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

/** "1.234,56", "1234,56", "1234.56", "-12". Formatos ambíguos ("1.234") são recusados. */
export function parseAmount(value: string): string | null {
  const v = value.trim().replace(/^R\$\s*/, "").replace(/^\+/, "");
  let plain: string;
  if (/^-?\d{1,3}(\.\d{3})+,\d{1,2}$/.test(v) || /^-?\d+,\d{1,2}$/.test(v)) plain = v.replace(/\./g, "").replace(",", ".");
  else if (/^-?\d+(\.\d{1,2})?$/.test(v)) plain = v;
  else if (/^-?\d+\.\d{9,}$/.test(v)) {
    // Resíduo binário de planilha (ex.: 0.30000000000000004).
    const d = new Decimal(v);
    if (d.minus(d.toDecimalPlaces(2)).abs().greaterThan("0.000001")) return null;
    plain = d.toFixed(2);
  } else return null;
  const result = new Decimal(plain);
  return result.abs().greaterThan("9999999999999.99") ? null : result.toFixed(2);
}

export function parseDate(value: string): string | null {
  const v = value.trim();
  const br = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(v);
  const iso = br ? `${br[3]}-${br[2]}-${br[1]}` : v;
  try {
    return businessDate(iso);
  } catch {
    return null;
  }
}

export function parseCsv(text: string): string[][] {
  const clean = text.replace(/^﻿/, "");
  const header = clean.slice(0, clean.indexOf("\n") + 1 || clean.length);
  const delimiter = [";", "\t", ","].find((d) => header.includes(d)) ?? ";";
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i]!;
    if (quoted) {
      if (ch !== '"') field += ch;
      else if (clean[i + 1] === '"') { field += '"'; i++; }
      else quoted = false;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === delimiter) { row.push(field); field = ""; }
    else if (ch === "\n") { row.push(field.replace(/\r$/, "")); rows.push(row); row = []; field = ""; }
    else field += ch;
    if (rows.length > MAX_ROWS + 1) throw new ParseError("TOO_MANY_ROWS");
  }
  if (quoted) throw new ParseError("CORRUPTED_FILE");
  if (field !== "" || row.length) { row.push(field.replace(/\r$/, "")); rows.push(row); }
  return rows.filter((r) => r.some((f) => f.trim() !== ""));
}

async function parseXlsx(bytes: Buffer): Promise<string[][]> {
  let data;
  try {
    // Números chegam como o texto gravado na planilha, sem passar por float.
    data = await readSheet<string>(bytes, { parseNumber: (s: string) => s });
  } catch {
    throw new ParseError("CORRUPTED_FILE");
  }
  if (data.length > MAX_ROWS + 1) throw new ParseError("TOO_MANY_ROWS");
  return data.map((r) => r.map((c) => c === null ? "" : c instanceof Date ? c.toISOString().slice(0, 10) : String(c)));
}

async function table(bytes: Buffer, extension: string, fields: string[], required: string[], mapping: Mapping) {
  const [header, ...lines] = extension === "xlsx" ? await parseXlsx(bytes) : parseCsv(decodeText(bytes));
  if (!header || lines.length === 0) throw new ParseError("EMPTY_FILE");
  const titles = header.map((h) => h.trim().toLowerCase());
  const index = new Map<string, number>();
  for (const field of fields) {
    const i = titles.indexOf((mapping[field] ?? field).trim().toLowerCase());
    if (i >= 0) index.set(field, i);
  }
  if (required.some((f) => !index.has(f))) throw new ParseError("MISSING_COLUMNS");
  return lines.map((line, n) => ({
    rowNumber: n + 1,
    raw: Object.fromEntries(header.map((h, i) => [h.trim() || `col${i + 1}`, line[i] ?? ""])),
    get: (field: string) => (index.has(field) ? (line[index.get(field)!] ?? "").trim() : ""),
  }));
}

function bankRow(rowNumber: number, raw: Record<string, string>, date: string | null, signed: string | null,
                 description: string, fitid: string): BankRow {
  const error = !date ? "INVALID_DATE" : signed === null ? "INVALID_AMOUNT"
    : new Decimal(signed).isZero() ? "ZERO_AMOUNT" : !description ? "MISSING_DESCRIPTION" : undefined;
  if (error) return { rowNumber, raw, error };
  return {
    rowNumber, raw, date: date!, direction: new Decimal(signed!).isNegative() ? "DEBIT" : "CREDIT",
    amount: new Decimal(signed!).abs().toFixed(2), description: description.slice(0, 300),
    fitid: fitid.slice(0, 120) || undefined,
  };
}

/** OFX 1.x (SGML, sem fechamento de tags) e 2.x (XML). */
export function parseOfx(bytes: Buffer): BankStatement {
  const head = bytes.subarray(0, 600).toString("latin1");
  const text = /CHARSET:\s*1252|encoding="(windows-1252|iso-8859-1)"/i.test(head)
    ? new TextDecoder("windows-1252").decode(bytes) : decodeText(bytes);
  if (!/<OFX>/i.test(text) || !/<\/OFX>/i.test(text)) throw new ParseError("CORRUPTED_FILE");
  const tag = (block: string, name: string) =>
    (new RegExp(`<${name}>([^<\\r\\n]*)`, "i").exec(block)?.[1] ?? "").trim()
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  const ofxDate = (v: string) => parseDate(`${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`);
  const currency = tag(text, "CURDEF");
  if (currency && currency !== "BRL") throw new ParseError("UNSUPPORTED_CURRENCY");
  if ((text.match(/<STMTRS>|<CCSTMTRS>/gi)?.length ?? 0) > 1) throw new ParseError("MULTIPLE_ACCOUNTS");

  const blocks = text.split(/<STMTTRN>/i).slice(1).map((b) => b.split(/<\/STMTTRN>|<\/BANKTRANLIST>/i)[0]!);
  if (blocks.length > MAX_ROWS) throw new ParseError("TOO_MANY_ROWS");
  const rows = blocks.map((block, i) => {
    const raw = Object.fromEntries(["TRNTYPE", "DTPOSTED", "TRNAMT", "FITID", "CHECKNUM", "NAME", "MEMO"]
      .map((n) => [n, tag(block, n)]).filter(([, v]) => v));
    return bankRow(i + 1, raw, ofxDate(tag(block, "DTPOSTED")), parseAmount(tag(block, "TRNAMT")),
      tag(block, "MEMO") || tag(block, "NAME"), tag(block, "FITID"));
  });
  return {
    rows,
    periodStart: ofxDate(tag(text, "DTSTART")) ?? undefined,
    periodEnd: ofxDate(tag(text, "DTEND")) ?? undefined,
  };
}

export async function parseBankStatement(bytes: Buffer, extension: string, mapping: Mapping = {}): Promise<BankStatement> {
  const statement = extension === "ofx" ? parseOfx(bytes) : {
    rows: (await table(bytes, extension, ["bank_posting_date", "amount", "description", "external_fitid"],
      ["bank_posting_date", "amount", "description"], mapping))
      .map((l) => bankRow(l.rowNumber, l.raw, parseDate(l.get("bank_posting_date")), parseAmount(l.get("amount")),
        l.get("description"), l.get("external_fitid"))),
  } as BankStatement;
  if (statement.rows.length === 0) throw new ParseError("NO_TRANSACTIONS");
  const dates = statement.rows.flatMap((r) => (r.date ? [r.date] : [])).sort();
  return {
    rows: statement.rows,
    periodStart: statement.periodStart ?? dates[0],
    periodEnd: statement.periodEnd ?? dates.at(-1),
  };
}

const ACQUIRER_FIELDS = ["external_nsu_tid", "operation_date", "installment_number", "total_installments",
  "gross_amount", "mdr_fee_amount", "anticipation_fee_amount", "other_fees", "net_amount",
  "expected_settlement_date", "settlement_date", "event_type"];
const EVENT_TYPES = ["SALE", "SETTLEMENT", "ANTICIPATION", "CHARGEBACK_REVERSAL"];

export async function parseAcquirerReport(bytes: Buffer, extension: string, mapping: Mapping = {}): Promise<AcquirerRow[]> {
  const lines = await table(bytes, extension, ACQUIRER_FIELDS,
    ["external_nsu_tid", "operation_date", "gross_amount", "mdr_fee_amount", "net_amount", "event_type"], mapping);
  return lines.map(({ rowNumber, raw, get }) => {
    const nsu = get("external_nsu_tid").slice(0, 100);
    const operationDate = parseDate(get("operation_date"));
    const eventType = get("event_type").toUpperCase();
    const money = (field: string) => (get(field) === "" ? "0.00" : parseAmount(get(field)));
    const [gross, mdr, anticipation, other, net] =
      [parseAmount(get("gross_amount")), money("mdr_fee_amount"), money("anticipation_fee_amount"),
       money("other_fees"), parseAmount(get("net_amount"))];
    const installment = Number(get("installment_number") || "1");
    const total = Number(get("total_installments") || "1");
    const badDate = ["expected_settlement_date", "settlement_date"].some((f) => get(f) !== "" && !parseDate(get(f)));
    let error: string | undefined;
    if (!nsu) error = "MISSING_NSU";
    else if (!operationDate || badDate) error = "INVALID_DATE";
    else if (!EVENT_TYPES.includes(eventType)) error = "INVALID_EVENT_TYPE";
    else if (!Number.isInteger(installment) || !Number.isInteger(total) || installment < 1 || installment > total) {
      error = "INVALID_INSTALLMENT";
    } else if ([gross, mdr, anticipation, other, net].some((v) => v === null)) error = "INVALID_AMOUNT";
    // Doc 3 §1.2: tolerância de R$ 0,02 por linha.
    else if (new Decimal(gross!).minus(mdr!).minus(anticipation!).minus(other!).minus(net!).abs().greaterThan("0.02")) {
      error = "AMOUNTS_DO_NOT_ADD_UP";
    }
    return error ? { rowNumber, raw, error }
      : { rowNumber, raw, nsu, operationDate: operationDate!, installment, totalInstallments: total, eventType,
          gross: gross!, mdr: mdr!, anticipationFee: anticipation!, otherFees: other!, net: net!,
          expectedDate: parseDate(get("expected_settlement_date")) ?? undefined,
          settlementDate: parseDate(get("settlement_date")) ?? undefined };
  });
}
