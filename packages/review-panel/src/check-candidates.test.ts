import { parseVerdictBlock } from "@titan-design/session-read";
import { describe, expect, it } from "vitest";
import { CHECK_CLASSES, CHECK_ROUTES, MAX_CHECK_SKETCH_CHARS, parseCheckCandidates } from "./check-candidates.js";
import { reviewerBrief } from "./reviewer-brief.js";

const HEAD = "a".repeat(40);
const VERDICT = `Verdict: MERGE\nPR: octo/demo#7\nHead: ${HEAD}`;
const BLOCK = ["Check-candidates:", "-  Parser-Edge-Case |  test | Fuzz the range reader with empty and reversed bounds", "- swallowed-error | lint | Flag a catch that drops the error"].join("\n");
const ITEMS = [
  { classKey: "parser-edge-case", route: "test", sketch: "Fuzz the range reader with empty and reversed bounds" },
  { classKey: "swallowed-error", route: "lint", sketch: "Flag a catch that drops the error" },
];
const line = (key: string, route = "lint", sketch = "Flag it"): string => `- ${key} | ${route} | ${sketch}`;
const block = (...lines: string[]): string => ["Check-candidates:", ...lines].join("\n");

describe("CHECK_CLASSES", () => {
  it("holds the audit's 45 standard keys once each, every one in kebab case", () => {
    const keys = CHECK_CLASSES.map((entry) => entry.key);

    expect(keys).toHaveLength(45);
    expect(new Set(keys).size).toBe(45);
    for (const key of keys) expect(key).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it("gives each key a check route, or none for the classes no check covers", () => {
    for (const entry of CHECK_CLASSES) expect([...CHECK_ROUTES, "none"]).toContain(entry.route);
    expect(CHECK_CLASSES.find((entry) => entry.key === "approval-or-gate-bypass")?.route).toBe("design");
    expect(CHECK_CLASSES.find((entry) => entry.key === "logic-bug-one-off")?.route).toBe("none");
  });
});

describe("parseCheckCandidates", () => {
  it("reads each line's normalised class key, route and trimmed sketch in order", () => {
    expect(parseCheckCandidates(`Looks right.\n\n${BLOCK}\n\n${VERDICT}\n`)).toEqual({ items: ITEMS });
  });

  it("reads a block written after the verdict lines", () => {
    expect(parseCheckCandidates(`${VERDICT}\n\n${BLOCK}\n`)).toEqual({ items: ITEMS });
  });

  it("keeps an unknown class as other:<slug>", () => {
    expect(parseCheckCandidates(block(line("Retry Budget  Unbounded!"), line("other: lock order"))).items.map((item) => item.classKey)).toEqual([
      "other:retry-budget-unbounded",
      "other:lock-order",
    ]);
  });

  it("drops the block on an unknown route", () => {
    expect(parseCheckCandidates(`${block(line("swallowed-error"), line("cosmetic", "none"))}\n\n${VERDICT}`)).toEqual({ items: [], warning: "bad_route" });
  });

  it.each([
    ["no block", VERDICT],
    ["an explicit none", `Check-candidates: none\n\n${VERDICT}`],
    ["a block inside a code fence", `\`\`\`\n${BLOCK}\n\`\`\`\n${VERDICT}`],
  ])("proposes nothing and warns nothing for %s", (_scenario, text) => {
    expect(parseCheckCandidates(text)).toEqual({ items: [] });
  });

  it.each([
    ["bad_item", "a line with two fields", block("- swallowed-error | lint")],
    ["bad_item", "a heading with no lines", "Check-candidates:\n\nLater."],
    ["bad_item", "a line whose key has no letter or digit", block(line("!!"))],
    ["bad_route", "the brief's template quoted back", block("- <class key> | <route> | <rule sketch>")],
    ["too_many", "six lines", block(...Array.from({ length: 6 }, (_, n) => line("swallowed-error", "lint", `Rule ${n}`)))],
    ["too_long", "a sketch over the bound", block(line("swallowed-error", "lint", "x".repeat(MAX_CHECK_SKETCH_CHARS + 1)))],
    ["multiple_blocks", "two headings", `${BLOCK}\n\n${BLOCK}`],
  ])("drops the whole block with %s for %s", (warning, _scenario, text) => {
    expect(parseCheckCandidates(`${text}\n\n${VERDICT}\n`)).toEqual({ items: [], warning });
  });

  it("never changes the verdict", () => {
    for (const verdict of ["MERGE", "FIX_FIRST"]) {
      const bare = VERDICT.replace("MERGE", verdict);
      for (const candidates of [BLOCK, block(line("swallowed-error", "none")), `${BLOCK}\n\n${BLOCK}`]) {
        for (const text of [`${candidates}\n\n${bare}`, `${bare}\n\n${candidates}`]) {
          expect(parseVerdictBlock(text)).toEqual({ ...parseVerdictBlock(bare), lineOffset: text.indexOf("Verdict:") === 0 ? 0 : expect.any(Number) });
        }
      }
    }
  });

  it("finds no candidate in the reviewer brief itself", () => {
    expect(parseCheckCandidates(reviewerBrief({ repo: "octo/demo", pr: 7, head: HEAD, checkoutRoot: "/reviews" }))).toEqual({ items: [] });
  });
});
