import { MAX_HEAD_FAILURES, type HeadMutantRun, type HeadMutantsReport } from "@titan-design/fix-proof";
import { describe, expect, it } from "vitest";
import type { BodyDeletePlan, BodyDeleteTarget } from "./body-delete.js";
import { DELETION_CANDIDATE_SIGNAL, extremeFindings, PSEUDO_TESTED_SIGNAL, type ExtremeFindingsInput } from "./pseudo-tested.js";

const HEAD = "abcdef0123456789abcdef0123456789abcdef01";
const PKG = "packages/a";

function target(file: string, symbol: string): BodyDeleteTarget {
  const nodeId = `${file}#${symbol}`;
  const header = `export function ${symbol}() {`;
  return {
    nodeId,
    file,
    symbol,
    lineStart: 3,
    lineEnd: 5,
    mutation: { name: `body-delete:${nodeId}`, file, find: header, replace: `${header} return undefined as never;` },
  };
}

function runOf(t: BodyDeleteTarget, outcome: HeadMutantRun["outcome"], failed: HeadMutantRun["failed"] = []): HeadMutantRun {
  return { name: t.mutation.name, file: t.file, package: PKG, built: true, outcome, failed };
}

const LOG = target(`${PKG}/src/log.ts`, "logged");
const ADD = target(`${PKG}/src/add.ts`, "add");
const LOG_TEST = `${PKG}/src/log.test.ts`;
const MIXED_TEST = `${PKG}/src/mixed.test.ts`;

interface Scenario {
  targets: BodyDeleteTarget[];
  runs: HeadMutantRun[];
  reach?: Record<string, string[]>;
  outsideTests?: Record<string, string[]>;
  skipped?: BodyDeletePlan["skipped"];
  unrun?: string[];
}

function input(s: Scenario): ExtremeFindingsInput {
  const reach = { [LOG_TEST]: [LOG.file], [MIXED_TEST]: [LOG.file, ADD.file], ...s.reach, ...s.outsideTests };
  const suite = Object.keys({ [LOG_TEST]: 0, [MIXED_TEST]: 0, ...s.reach });
  const report: HeadMutantsReport = {
    head: HEAD,
    suites: { [PKG]: suite },
    baseline: suite.map((file) => ({ test: `${file} test`, file, status: "passed" as const })),
    runs: s.runs,
    unrun: s.unrun ?? [],
    wallMs: 1234,
    builds: s.runs.length + 1,
  };
  return {
    plan: { targets: s.targets, skipped: s.skipped ?? [] },
    report,
    reachedFiles: (file) => new Set(reach[file] ?? []),
    testFiles: Object.keys(reach),
  };
}

function signals(i: ExtremeFindingsInput, signal: string): string[] {
  return extremeFindings(i).findings.filter((f) => f.signal === signal).map((f) => f.id);
}

describe("extremeFindings: pseudo-tested", () => {
  it("gives one finding keyed on the node id for a survived target", () => {
    const { findings } = extremeFindings(input({ targets: [LOG], runs: [runOf(LOG, "survived")] }));

    const pseudo = findings.filter((f) => f.signal === PSEUDO_TESTED_SIGNAL);
    expect(pseudo).toEqual([
      {
        id: `code-graph:pseudo-tested:${LOG.nodeId}`,
        path: LOG.file,
        lineStart: 3,
        lineEnd: 5,
        symbol: "logged",
        signal: "pseudo-tested",
        severity: "warning",
        tool: "code-graph",
        evidence: `covered at abcdef0; body made to return at once; built; 2 tests in ${PKG} ran, none failed`,
      },
    ]);
  });

  it("gives none for a caught or caught-error target", () => {
    const failure = [{ test: "x", file: LOG_TEST, assertion: true }];
    const i = input({ targets: [LOG, ADD], runs: [runOf(LOG, "caught", failure), runOf(ADD, "caught-error", failure)] });
    expect(signals(i, PSEUDO_TESTED_SIGNAL)).toEqual([]);
  });

  it("reads a survived target reached from a test file outside its suite as unverified, with no finding", () => {
    const outside = { "packages/b/src/uses-log.test.ts": [LOG.file] };
    const i = input({ targets: [LOG], runs: [runOf(LOG, "survived")], outsideTests: outside });

    const { findings, summary } = extremeFindings(i);

    expect(findings).toEqual([]);
    expect(summary).toMatchObject({ survived: 0, unverified: 1, excluded: 0 });
  });

  it("excludes unrun, unbuilt, unapplied, load-error and timeout targets", () => {
    const [a, b, c, d, e] = ["a", "b", "c", "d", "e"].map((s) => target(`${PKG}/src/${s}.ts`, s)) as BodyDeleteTarget[];
    const runs = [
      { ...runOf(b!, undefined), built: false },
      { ...runOf(c!, undefined), built: false, error: "find absent" },
      runOf(d!, "load-error"),
      runOf(e!, "timeout"),
    ];
    const { findings, summary } = extremeFindings(input({ targets: [a!, b!, c!, d!, e!], runs, unrun: [a!.mutation.name] }));

    expect(findings).toEqual([]);
    expect(summary).toMatchObject({ targets: 5, excluded: 5, survived: 0 });
  });
});

describe("extremeFindings: test-deletion-candidate", () => {
  it("lists a passing test that failed under nothing and reaches only survived targets", () => {
    const i = input({ targets: [LOG], runs: [runOf(LOG, "survived")] });
    expect(signals(i, DELETION_CANDIDATE_SIGNAL)).toEqual([
      `code-graph:test-deletion-candidate:${LOG_TEST}::${LOG_TEST} test`,
      `code-graph:test-deletion-candidate:${MIXED_TEST}::${MIXED_TEST} test`,
    ]);
  });

  it("keeps off a test that also reaches one caught target, even though it never failed", () => {
    const failure = [{ test: "other", file: "packages/a/src/other.test.ts", assertion: true }];
    const i = input({ targets: [LOG, ADD], runs: [runOf(LOG, "survived"), runOf(ADD, "caught", failure)] });
    expect(signals(i, DELETION_CANDIDATE_SIGNAL)).toEqual([`code-graph:test-deletion-candidate:${LOG_TEST}::${LOG_TEST} test`]);
  });

  it("keeps off a test that failed under some run", () => {
    const failure = [{ test: `${LOG_TEST} test`, file: LOG_TEST, assertion: false }];
    const i = input({ targets: [LOG, ADD], runs: [runOf(LOG, "survived"), runOf(ADD, "caught-error", failure)] });
    expect(signals(i, DELETION_CANDIDATE_SIGNAL)).toEqual([]);
  });

  it("never lets a run whose failure list hit the cap support a candidate in its suite", () => {
    const failures = (n: number) => Array.from({ length: n }, (_, k) => ({ test: `t${k}`, file: `${PKG}/src/other.test.ts`, assertion: true }));
    const at = (n: number) => input({ targets: [LOG, ADD], runs: [runOf(LOG, "survived"), runOf(ADD, "caught", failures(n))], reach: { [MIXED_TEST]: [LOG.file] } });

    expect(signals(at(MAX_HEAD_FAILURES - 1), DELETION_CANDIDATE_SIGNAL)).toHaveLength(2);
    expect(signals(at(MAX_HEAD_FAILURES), DELETION_CANDIDATE_SIGNAL)).toEqual([]);
    expect(extremeFindings(at(MAX_HEAD_FAILURES)).summary.truncated).toBe(1);
  });

  it("never lists a test that reaches no target", () => {
    const i = input({ targets: [LOG], runs: [runOf(LOG, "survived")], reach: { [LOG_TEST]: [], [MIXED_TEST]: [] } });
    expect(signals(i, DELETION_CANDIDATE_SIGNAL)).toEqual([]);
  });

  it("names how many mutants the test reaches and the first three symbols", () => {
    const more = ["b", "c", "d"].map((s) => target(LOG.file, s));
    const targets = [LOG, ...more];
    const i = input({ targets, runs: targets.map((t) => runOf(t, "survived")), reach: { [MIXED_TEST]: [] } });

    const [candidate] = extremeFindings(i).findings.filter((f) => f.signal === DELETION_CANDIDATE_SIGNAL);

    expect(candidate?.evidence).toBe("passed at abcdef0; failed under none of 4 body-delete mutants it reaches (logged, b, c); advisory only, never deleted");
  });
});

function keysOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysOf);
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, inner]) => [key, ...keysOf(inner)]);
}

describe("extremeFindings: summary", () => {
  it("counts every target once and every skip by reason", () => {
    const failure = [{ test: "x", file: LOG_TEST, assertion: true }];
    const skipped: BodyDeletePlan["skipped"] = [
      { nodeId: "x#a", reason: "uncovered" },
      { nodeId: "x#b", reason: "uncovered" },
      { nodeId: "x#c", reason: "capped" },
    ];
    const { summary } = extremeFindings(input({ targets: [LOG, ADD], runs: [runOf(LOG, "survived"), runOf(ADD, "caught", failure)], skipped }));

    expect(summary).toMatchObject({ head: HEAD, targets: 2, survived: 1, caught: 1, caughtError: 0, builds: 3, wallMs: 1234 });
    expect(summary.skipped).toMatchObject({ uncovered: 2, capped: 1, unchanged: 0 });
  });

  it("holds no score, rate, ratio or pct key anywhere in the summary or the findings (G2)", () => {
    const i = input({ targets: [LOG, ADD], runs: [runOf(LOG, "survived"), runOf(ADD, "survived")] });
    const { findings, summary } = extremeFindings(i);

    expect(findings.length).toBeGreaterThan(0);
    expect(keysOf({ findings, summary }).filter((key) => /score|rate|ratio|pct/i.test(key))).toEqual([]);
  });
});
