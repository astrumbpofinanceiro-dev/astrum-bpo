import { describe, expect, it } from "vitest";
import { addMonths } from "../../src/shared/dates/months.ts";

describe("parcelas mensais", () => {
  it("mantém o dia e ajusta para o fim do mês quando ele não existe", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2026-01-31", 2)).toBe("2026-03-31");
    expect(addMonths("2024-01-31", 1)).toBe("2024-02-29");
    expect(addMonths("2026-11-10", 2)).toBe("2027-01-10");
    expect(addMonths("2026-12-15", 12)).toBe("2027-12-15");
  });
});
