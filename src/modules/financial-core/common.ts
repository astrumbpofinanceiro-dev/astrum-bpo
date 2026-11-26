import type pg from "pg";
import { Decimal } from "decimal.js";
import { z } from "zod";
import { businessDate } from "../../shared/dates/business-date";
import { invalid } from "../../shared/errors";
import { resolveSetting, today } from "../tenants-config/settings";

export const date = z.string().refine((v) => { try { businessDate(v); return true; } catch { return false; } });
export const amount = z.string().regex(/^\d{1,13}(\.\d{1,2})?$/);
export const positive = amount.refine((v) => new Decimal(v).greaterThan(0));
export const reason = z.string().trim().min(10).max(1000);

export const dec = (v: string | number = 0) => new Decimal(v);
export const total = (values: (string | Decimal)[]) => values.reduce<Decimal>((a, v) => a.plus(v), new Decimal(0));
export const fixed = (v: Decimal) => v.toFixed(2);

/** Divide em N partes de centavos; a sobra vai para a última. */
export function split(value: string, parts: number): string[] {
  const cents = dec(value).times(100);
  const base = cents.dividedToIntegerBy(parts);
  return Array.from({ length: parts }, (_, i) =>
    fixed((i === parts - 1 ? cents.minus(base.times(parts - 1)) : base).dividedBy(100)));
}

export async function tolerance(c: pg.PoolClient, tenantId: string) {
  return dec((await resolveSetting(c, tenantId, "RECONCILIATION_TOLERANCE", today())) ?? "0.05");
}

export async function requireRow<T = Record<string, string>>(
  c: pg.PoolClient, sql: string, values: unknown[], code = "INVALID_REFERENCE",
): Promise<T> {
  const row = (await c.query(sql, values)).rows[0];
  if (!row) throw invalid(code);
  return row as T;
}
