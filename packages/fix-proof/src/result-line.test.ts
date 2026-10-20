import { describe, expect, it } from "vitest";
import type { Classification } from "./classify.js";
import type { FixProofPlan } from "./plan.js";
import { formatResultLine, parseResultLine, provedByMutants, RESULT_LINE_MAX_BYTES, toResult, type FixProofResult } from "./result-line.js";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);

const plan: FixProofPlan = {
  tests: ["src/a.test.ts"],
  carried: [],
  deletedTests: ["src/gone.test.ts"],
  overlayRemovals: [],
  mutations: [],
  source: [],
  config: { tests: ["**/*.test.ts"], carry: [], runtime: [] },
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

describe("provedByMutants", () => {
  const testOnly = (overrides: Partial<FixProofResult> = {}): FixProofResult => ({
    ...result(),
    verdict: "vacuous",
    deletedTests: [],
    counts: { reproduces: 0, "passes-on-base": 2, "new-api": 0, "fails-on-head": 0, "not-run": 0 },
    mutants: { verdict: "killed", results: [{ spec: "src/a.test.mutations.json", name: "drop the bound", outcome: "killed" }], uncovered: [] },
    ...overrides,
  });

  it("proves a vacuous result whose every mutation is killed by tests that pass at head", () => {
    expect(provedByMutants(testOnly())).toBe(true);
  });

  it("does not prove a result whose mutation survived", () => {
    expect(provedByMutants(testOnly({ mutants: { verdict: "not-killed", results: [{ spec: "src/a.test.mutations.json", name: "drop the bound", outcome: "survived" }] } }))).toBe(false);
  });

  it.each([
    ["a test fails at head", { "fails-on-head": 1 }],
    ["a test did not run", { "not-run": 1 }],
    ["no test ran", { "passes-on-base": 0 }],
  ])("does not prove killed mutants when %s", (_, counts) => {
    expect(provedByMutants(testOnly({ counts: { ...testOnly().counts, ...counts } }))).toBe(false);
  });

  it("does not prove killed mutants with a changed test file no spec covers", () => {
    const mutants = { ...testOnly().mutants!, uncovered: ["src/guard.test.ts"] };

    expect(provedByMutants(testOnly({ mutants }))).toBe(false);
  });

  it("does not prove killed mutants on a diff that deletes a test", () => {
    expect(provedByMutants(testOnly({ deletedTests: ["src/guard.test.ts"] }))).toBe(false);
  });

  it("does not prove killed mutants from a judge that never checked coverage", () => {
    const unchecked = { verdict: "killed" as const, results: testOnly().mutants!.results };

    expect(provedByMutants(testOnly({ mutants: unchecked }))).toBe(false);
  });

  it("refuses a killed verdict that lists an uncovered test file", () => {
    const mutants = { ...testOnly().mutants!, uncovered: ["src/guard.test.ts"] };

    expect(() => formatResultLine(testOnly({ mutants }))).toThrow(/killed with an uncovered test file/);
  });

  it("round-trips the uncovered list on a not-killed line", () => {
    const mutants = { ...testOnly().mutants!, verdict: "not-killed" as const, uncovered: ["src/guard.test.ts"] };

    const line = parseResultLine(formatResultLine(testOnly({ mutants })));

    expect(line.ok && line.result.mutants).toEqual(mutants);
  });

  it("does not prove a result with no mutation check or a mutants error", () => {
    expect(provedByMutants(testOnly({ mutants: undefined }))).toBe(false);
    expect(provedByMutants(testOnly({ mutants: { verdict: "error", results: [], error: "mutants side skipped" } }))).toBe(false);
  });
});

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

  it("drops killed mutants from the end first, then the others from the end", () => {
    const named = (name: string, outcome: "killed" | "survived" | "unbuilt") => ({ spec: SPEC, name: name.padEnd(150, "."), outcome });
    const results = [named("k0", "killed"), named("s0", "survived"), named("k1", "killed"), named("u0", "unbuilt"), named("k2", "killed")];
    const mixed = { ...killed(), mutants: { verdict: "not-killed" as const, results: [...results, ...Array.from({ length: 30 }, (_, index) => named(`k${index + 3}`, "killed"))] } };

    const parsed = parseResultLine(formatResultLine(mixed));
    const kept = parsed.ok ? (parsed.result.mutants?.results ?? []).map((result) => result.name.replace(/\.+$/, "")) : [];

    expect(parsed.ok && parsed.result.truncated).toBe(true);
    expect(kept.filter((name) => !name.startsWith("k"))).toEqual(["s0", "u0"]);
    const keptKilled = kept.filter((name) => name.startsWith("k"));
    expect(keptKilled).toEqual(Array.from({ length: keptKilled.length }, (_, index) => `k${index}`));
    expect(keptKilled.length).toBeLessThan(33);
  });

  it("drops non-killed mutants from the end once no killed mutant is left", () => {
    const named = (index: number) => ({ spec: SPEC, name: `s${index}`.padEnd(150, "."), outcome: "survived" as const });
    const big = { ...killed(), mutants: { verdict: "not-killed" as const, results: Array.from({ length: 40 }, (_, index) => named(index)) } };

    const parsed = parseResultLine(formatResultLine(big));
    const kept = parsed.ok ? (parsed.result.mutants?.results ?? []).map((result) => result.name) : [];

    expect(kept.length).toBeLessThan(40);
    expect(kept).toEqual(Array.from({ length: kept.length }, (_, index) => named(index).name));
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
