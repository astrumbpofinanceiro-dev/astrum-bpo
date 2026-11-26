/** Soma meses mantendo o dia, ou o último dia do mês quando o dia não existe. */
export function addMonths(isoDate: string, n: number) {
  const [y, m, d] = isoDate.split("-").map(Number) as [number, number, number];
  const total = (m - 1) + n;
  const year = y + Math.floor(total / 12), month = ((total % 12) + 12) % 12;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}
