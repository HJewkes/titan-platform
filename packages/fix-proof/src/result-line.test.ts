import { describe, expect, it } from "vitest";
import type { Classification } from "./classify.js";
import type { FixProofPlan } from "./plan.js";
import { formatResultLine, parseResultLine, RESULT_LINE_MAX_BYTES, toResult, type FixProofResult } from "./result-line.js";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);

const plan: FixProofPlan = {
  tests: ["src/a.test.ts"],
  carried: [],
  deletedTests: ["src/gone.test.ts"],
  overlayRemovals: [],
  mutations: [],
  source: [],
  config: { tests: ["**/*.test.ts"], carry: [] },
  configEdited: false,
};

const classification: Classification = {
  verdict: "reproduced",
  tests: [
    { file: "src/a.test.ts", name: "parses", class: "reproduces" },
    { file: "src/a.test.ts", name: "other", class: "passes-on-base" },
  ],
  files: [{ file: "src/a.test.ts", base: "ran", head: "ran" }],
};

const result = (): FixProofResult => toResult({ head: HEAD, mergeBase: BASE, plan, classification });

describe("toResult", () => {
  it("counts classes and carries the plan's deleted tests", () => {
    expect(result()).toMatchObject({
      verdict: "reproduced",
      counts: { reproduces: 1, "passes-on-base": 1, "new-api": 0, "fails-on-head": 0, "not-run": 0 },
      deletedTests: ["src/gone.test.ts"],
      notCollected: [],
      truncated: false,
    });
  });
});

describe("formatResultLine and parseResultLine", () => {
  it("round-trips a result", () => {
    const line = formatResultLine(result());

    expect(line.startsWith("fix-proof/v1 {")).toBe(true);
    expect(parseResultLine(line)).toEqual({ ok: true, result: result() });
  });

  it("drops test entries to stay within 4 KB and marks the result truncated", () => {
    const many = { ...result(), tests: Array.from({ length: 200 }, (_, index) => ({ file: "src/a.test.ts", name: `case ${index}`, class: "passes-on-base" as const })) };

    const line = formatResultLine(many);
    const parsed = parseResultLine(line);

    expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(RESULT_LINE_MAX_BYTES);
    expect(parsed.ok && parsed.result.truncated).toBe(true);
    expect(parsed.ok && parsed.result.verdict).toBe("reproduced");
  });

  it("keeps a reproducing test listed last when trimming many passing tests to 4 KB", () => {
    const passing = Array.from({ length: 200 }, (_, index) => ({ file: "src/a.test.ts", name: `case ${index}`, class: "passes-on-base" as const }));
    const reproducing = { file: "src/a.test.ts", name: "the bug", class: "reproduces" as const };
    const many = { ...result(), tests: [...passing, reproducing] };

    const parsed = parseResultLine(formatResultLine(many));

    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.result.truncated).toBe(true);
    expect(parsed.ok && parsed.result.tests).toContainEqual(reproducing);
  });

  it("refuses to format a result that would not parse back", () => {
    expect(() => formatResultLine({ ...result(), head: "HEAD" })).toThrow(/head/);
  });

  it("refuses a line over 4 KB", () => {
    const line = formatResultLine(result());
    const padded = line.replace('"parses"', `"${"x".repeat(RESULT_LINE_MAX_BYTES)}"`);

    expect(parseResultLine(padded)).toMatchObject({ ok: false, error: "result line exceeds 4 KB" });
  });

  it("refuses another version", () => {
    const line = formatResultLine(result()).replace("fix-proof/v1", "fix-proof/v2");

    expect(parseResultLine(line).ok).toBe(false);
  });

  it("refuses an unknown top-level field", () => {
    const line = formatResultLine(result()).replace(/}$/, ',"override":"reproduced"}');

    expect(parseResultLine(line)).toMatchObject({ ok: false, error: "unknown field override" });
  });

  it("refuses an unknown field inside a test entry", () => {
    const line = formatResultLine(result()).replace('"class":"reproduces"', '"class":"reproduces","trusted":true');

    expect(parseResultLine(line)).toMatchObject({ ok: false, error: "unknown field tests[].trusted" });
  });

  it("refuses a duplicate key that would override the verdict", () => {
    const line = formatResultLine({ ...result(), verdict: "vacuous" }).replace('"verdict":"vacuous"', '"verdict":"vacuous","verdict":"reproduced"');

    expect(parseResultLine(line)).toMatchObject({ ok: false, error: expect.stringMatching(/canonical/) });
  });

  it.each([
    ["an unknown verdict", (line: string) => line.replace('"verdict":"reproduced"', '"verdict":"proven"')],
    ["a short head sha", (line: string) => line.replace(HEAD, "abc123")],
    ["a negative count", (line: string) => line.replace('"reproduces":1', '"reproduces":-1')],
    ["invalid JSON", (line: string) => line.slice(0, -1)],
    ["a reproduced verdict with no reproducing test", (line: string) => line.replace('"reproduces":1', '"reproduces":0')],
  ])("refuses %s", (_label, mutate) => {
    expect(parseResultLine(mutate(formatResultLine(result()))).ok).toBe(false);
  });
});

describe("the mutants field", () => {
  const SPEC = "src/a.test.mutations.json";
  const killed = (): FixProofResult => ({
    ...result(),
    verdict: "vacuous",
    counts: { ...result().counts, reproduces: 0 },
    tests: [],
    mutants: { verdict: "killed", results: [{ spec: SPEC, name: "flip", outcome: "killed" }] },
  });

  it("round-trips a result carrying mutants", () => {
    expect(parseResultLine(formatResultLine(killed()))).toEqual({ ok: true, result: killed() });
  });

  it("refuses a line whose mutants keys are reordered", () => {
    const line = formatResultLine(killed()).replace('"mutants":{"verdict":"killed","results":', '"mutants":{"results":');
    const reordered = line.replace(/}$/, "").replace(/]}$/, '],"verdict":"killed"}}');

    expect(parseResultLine(reordered)).toMatchObject({ ok: false, error: expect.stringMatching(/canonical/) });
  });

  it.each([
    ["a killed verdict over a survived mutant", (line: string) => line.replace('"outcome":"killed"', '"outcome":"survived"')],
    ["an unknown mutant outcome", (line: string) => line.replace('"outcome":"killed"', '"outcome":"dead"')],
    ["an unknown mutants verdict", (line: string) => line.replace('"verdict":"killed"', '"verdict":"proven"')],
    ["an unknown field inside a mutant", (line: string) => line.replace('"outcome":"killed"', '"outcome":"killed","trusted":true')],
    ["a killed verdict with no mutant", (line: string) => line.replace(/"results":\[[^\]]*\]/, '"results":[]')],
  ])("refuses %s", (_label, mutate) => {
    expect(parseResultLine(mutate(formatResultLine(killed()))).ok).toBe(false);
  });

  it("drops killed mutants before the ones a not-killed verdict rests on, and keeps the verdict", () => {
    const many = Array.from({ length: 60 }, (_, index) => ({ spec: SPEC, name: `killed ${index}`, outcome: "killed" as const }));
    const survived = { spec: SPEC, name: "the gap", outcome: "survived" as const, failed: [] };
    const big = { ...killed(), mutants: { verdict: "not-killed" as const, results: [survived, ...many] } };

    const parsed = parseResultLine(formatResultLine(big));

    expect(parsed.ok && parsed.result.truncated).toBe(true);
    expect(parsed.ok && parsed.result.mutants?.verdict).toBe("not-killed");
    expect(parsed.ok && parsed.result.mutants?.results).toContainEqual(survived);
  });
});
