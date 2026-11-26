import { Decimal } from "decimal.js";

const Money = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
const MAX = new Money("9999999999999.99"); // limite de NUMERIC(15,2)

/** Aceita apenas string decimal (formato do banco) — nunca number/float. */
export function money(value: string): Decimal {
  if (!/^-?\d+(\.\d+)?$/.test(value)) throw new Error(`Valor monetário inválido: ${value}`);
  return new Money(value);
}

export function sum(values: readonly Decimal[]): Decimal {
  return values.reduce((acc, v) => acc.plus(v), new Money(0));
}

/** Arredonda (ROUND_HALF_UP, 2 casas) somente na consolidação final (Doc 3 §0). */
export function toDbAmount(value: Decimal): string {
  const rounded = value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  if (rounded.abs().greaterThan(MAX)) throw new Error("Valor excede NUMERIC(15,2)");
  return rounded.toFixed(2);
}
