import { describe, expect, it } from "vitest";
import { parseIntentDigest } from "./intent-digest.js";

const HEAD = ["---", "schema: titan-intent-digest/v1", "slug: demo", "initiative: sample", "built_from: invented rows", "---"];
const SECTIONS = ["Standing direction", "Reasons", "Ruled out", "Taste", "Open questions", "Superseded"];

/** Builds a digest whose given section holds the given bullet lines; every other section is empty. */
function digest(bullets: Record<string, string[]> = {}): string {
  return [...HEAD, ...SECTIONS.flatMap((name) => [`## ${name}`, ...(bullets[name] ?? [])])].join("\n");
}

const good = (n: number, extra = "") => `- I${n} 2026-01-0${n} "invented quote ${n}" (quote: msg:abc${n})${extra}`;

function errorsOf(text: string) {
  const result = parseIntentDigest(text);
  if (result.ok) throw new Error("expected the digest to be refused");
  return result.errors;
}

describe("parseIntentDigest", () => {
  it("parses a valid digest into lines carrying id, date, quote, ref and section", () => {
    const result = parseIntentDigest(digest({ "Standing direction": [good(3)], Reasons: [good(4)] }));
    expect(result).toEqual({
      ok: true,
      slug: "demo",
      initiative: "sample",
      builtFrom: "invented rows",
      lines: [
        { id: "demo/I3", date: "2026-01-03", quote: "invented quote 3", ref: "msg:abc3", section: "Standing direction" },
        { id: "demo/I4", date: "2026-01-04", quote: "invented quote 4", ref: "msg:abc4", section: "Reasons" },
      ],
    });
  });

  it("keeps a double quote inside the quote and ends it at the last quote-ref marker", () => {
    const line = '- I1 2026-01-01 "she said "go" (quote: not a ref) then left" (quote: msg:q1)';
    const result = parseIntentDigest(digest({ Taste: [line] }));
    expect(result.ok && result.lines[0]?.quote).toBe('she said "go" (quote: not a ref) then left');
    expect(result.ok && result.lines[0]?.ref).toBe("msg:q1");
  });

  it("records superseded-by as a full id", () => {
    const result = parseIntentDigest(digest({ "Standing direction": [good(1)], Superseded: [good(2, " superseded-by: I1")] }));
    expect(result.ok && result.lines[1]?.supersededBy).toBe("demo/I1");
  });

  it.each([
    ["no quote", '- I1 2026-01-01 (quote: msg:a1)', "no quote"],
    ["an empty quote", '- I1 2026-01-01 "" (quote: msg:a1)', "quote is empty"],
    ["no date", '- I1 "q" (quote: msg:a1)', "date"],
    ["a non-ISO date", '- I1 01/02/2026 "q" (quote: msg:a1)', "date"],
    ["an impossible date", '- I1 2026-02-31 "q" (quote: msg:a1)', "date"],
    ["no ref", '- I1 2026-01-01 "q"', "(quote: <ref>)"],
    ["a ref that is free text", '- I1 2026-01-01 "q" (quote: two words)', "(quote: <ref>)"],
  ])("refuses a bullet with %s, naming its line", (_name, bullet, fragment) => {
    const text = digest({ Reasons: [good(2), bullet] });
    const errors = errorsOf(text);
    expect(errors[0]?.line).toBe(text.split("\n").indexOf(bullet) + 1);
    expect(errors[0]?.message).toContain(fragment);
  });

  it("refuses a ref that is not a single token reference", () => {
    const errors = errorsOf(digest({ Reasons: ['- I1 2026-01-01 "q" (quote: -bad)'] }));
    expect(errors[0]?.message).toContain("quote_ref");
  });

  it("refuses an unknown section", () => {
    const errors = errorsOf(`${digest()}\n## Hunches\n`);
    expect(errors.map((e) => e.message)).toContain('unknown section "Hunches"');
  });

  it("refuses a duplicate id", () => {
    const errors = errorsOf(digest({ Reasons: [good(1)], Taste: [good(1)] }));
    expect(errors.some((e) => e.message.includes("duplicate id demo/I1"))).toBe(true);
  });

  it("refuses a superseded-by naming an id that is not in the file", () => {
    const errors = errorsOf(digest({ Superseded: [good(2, " superseded-by: I9")] }));
    expect(errors[0]?.message).toContain("demo/I9");
  });

  it("refuses a missing section and a wrong schema", () => {
    const text = digest().replace("## Taste\n", "").replace("titan-intent-digest/v1", "other/v2");
    const messages = errorsOf(text).map((e) => e.message);
    expect(messages).toContain('missing section "Taste"');
    expect(messages.some((m) => m.startsWith("schema must be"))).toBe(true);
  });

  it("accepts a digest whose sections are all empty", () => {
    expect(parseIntentDigest(digest())).toMatchObject({ ok: true, lines: [] });
  });
});
