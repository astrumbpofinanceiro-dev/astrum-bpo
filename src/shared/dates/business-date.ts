/** Data de negócio "YYYY-MM-DD". Não usar `Date` (sofre conversão de fuso). */
export type BusinessDate = string & { readonly __brand: "BusinessDate" };

export function businessDate(value: string): BusinessDate {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const [y, mo, d] = m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
  const check = new Date(Date.UTC(y, mo - 1, d));
  if (!m || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) throw new Error(`Data inválida: ${value}`);
  return value as BusinessDate;
}

export function firstDayOfMonth(value: BusinessDate): BusinessDate {
  return `${value.slice(0, 7)}-01` as BusinessDate;
}
