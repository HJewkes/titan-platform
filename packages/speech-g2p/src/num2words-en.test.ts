import { describe, expect, it } from "vitest";
import golden from "./fixtures/num2words.golden.json" with { type: "json" };
import { cardinal, decimal, ordinal, year } from "./num2words-en.js";

const render: Record<string, (value: number) => string> = {
  cardinal: (v) => (Number.isInteger(v) ? cardinal(v) : decimal(String(v))),
  ordinal,
  year,
};

describe("num2words golden", () => {
  it("every recorded num2words 0.5.14 value matches", () => {
    const misses = golden.cases
      .map((c) => ({ ...c, got: render[c.form]!(c.value as number) }))
      .filter((c) => c.got !== c.words);
    expect(misses).toEqual([]);
    expect(golden.cases).toHaveLength(170);
  });

  it("joins a trailing group with and, and other groups with a comma", () => {
    expect(cardinal(147)).toBe("one hundred and forty-seven");
    expect(cardinal(1100)).toBe("one thousand, one hundred");
    expect(cardinal(1001)).toBe("one thousand and one");
  });

  it("reads years in pairs, with oh for a single-digit tail", () => {
    expect(year(1984)).toBe("nineteen eighty-four");
    expect(year(1901)).toBe("nineteen oh-one");
    expect(year(2000)).toBe("two thousand");
  });

  it("suffixes the last word of an ordinal", () => {
    expect(ordinal(21)).toBe("twenty-first");
    expect(ordinal(1984)).toBe("one thousand, nine hundred and eighty-fourth");
  });

  it("reads a whole-valued float as a cardinal and drops trailing fraction zeros", () => {
    expect(decimal("5.0")).toBe("five");
    expect(decimal("1.50")).toBe("one point five");
  });
});
