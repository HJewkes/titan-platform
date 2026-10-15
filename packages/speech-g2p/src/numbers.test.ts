import { describe, expect, it } from "vitest";
import golden from "./fixtures/numbers.golden.json" with { type: "json" };
import { appendCurrency, getNumber, isCurrency, isNumber, numericIfNeeded, type NumberLexicon } from "./numbers.js";

// Expected values recorded from misaki 0.9.4 `Lexicon.get_number` and friends, with the same
// stand-in lookups (`<word>`, rating 4, `point` rating 3; `_s` -> `+s`) patched into the Python class.
const lexicon: NumberLexicon = {
  lookup: (w) => [`<${w}>`, w === "point" ? 3 : 4],
  stemS: (w) => [`<${w.slice(0, -1)}>S`, 2],
  suffixS: (p) => `${p}+s`,
  suffixEd: (p) => `${p}+ed`,
  suffixIng: (p) => `${p}+ing`,
};

const key = (c: { word: string; currency: string | null; isHead: boolean; flags: string }) =>
  `${c.word} ${c.currency ?? "-"} ${c.isHead ? "head" : "tail"} ${c.flags || "-"}`;

describe("get_number against misaki", () => {
  it("matches every recorded reading", () => {
    const misses = golden.getNumber
      .map((c) => ({ k: key(c), want: c.result, got: getNumber(c.word, c.currency, c.isHead, c.flags, lexicon) }))
      .filter((c) => JSON.stringify(c.want) !== JSON.stringify(c.got));
    expect(misses).toEqual([]);
    expect(golden.getNumber.length).toBeGreaterThan(400);
  });

  it("reads $5.99 as dollars and cents, $1 as a singular dollar", () => {
    expect(getNumber("5.99", "$", true, "", lexicon)[0]).toBe("<five> <dollar>S <and> <ninety> <nine> <cent>S");
    expect(getNumber("1", "$", true, "", lexicon)[0]).toBe("<one> <dollar>");
  });

  it("reads a lone 4-digit head as a year and a leading-zero run digit by digit", () => {
    expect(getNumber("1984", null, true, "", lexicon)[0]).toBe("<nineteen> <eighty> <four>");
    expect(getNumber("007", null, false, "", lexicon)[0]).toBe("<zero> <zero> <seven>");
  });

  it("reads a non-head digit run digit by digit rather than as a cardinal", () => {
    expect(getNumber("1234", "$", false, "", lexicon)[0]).toBe("<one> <two> <three> <four>");
  });
});

describe("is_number, is_currency, append_currency, numeric_if_needed", () => {
  it("is_number matches every recorded verdict", () => {
    for (const c of golden.isNumber) expect([c.word, c.isHead, isNumber(c.word, c.isHead)]).toEqual([c.word, c.isHead, c.result]);
  });

  it("is_currency matches every recorded verdict", () => {
    for (const c of golden.isCurrency) expect([c.word, isCurrency(c.word)]).toEqual([c.word, c.result]);
  });

  it("append_currency adds the plural unit only for known symbols", () => {
    for (const c of golden.append) expect(appendCurrency(c.ps, c.currency, lexicon)).toBe(c.result);
  });

  it("numeric_if_needed turns digit characters into ASCII and leaves the rest", () => {
    for (const c of golden.numeric) expect([c.char, numericIfNeeded(c.char)]).toEqual([c.char, c.result]);
  });
});
