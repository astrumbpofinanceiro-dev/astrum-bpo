import { describe, expect, it } from "vitest";
import { money, sum, toDbAmount } from "./money";
import { businessDate, firstDayOfMonth } from "../dates/business-date";

describe("dinheiro e datas de negócio", () => {
  it("soma exata e arredonda meio para cima só no final", () => {
    expect(toDbAmount(sum([money("0.10"), money("0.20")]))).toBe("0.30");
    expect(toDbAmount(money("1.005"))).toBe("1.01");
  });
  it("rejeita formatos e datas inválidas", () => {
    expect(() => money("1,50")).toThrow();
    expect(() => businessDate("2026-02-30")).toThrow();
    expect(firstDayOfMonth(businessDate("2026-11-25"))).toBe("2026-11-01");
  });
});
