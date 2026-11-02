import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { withHistory, type HistoryCommit } from "@titan-design/test-kit/git";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CostOf } from "./cost.js";
import type { CorpusRow } from "./extract.js";
import { readOnlyUri } from "./factory-db.js";
import { buildCorpus } from "./run.js";
import { lines, scratchRepo, writeFactoryDb, type FixtureGate, type FixtureRun, type FixtureStep, type ScratchRepo } from "./test-fixture.js";

const REPO = "Acme/widgets";
const NOW = new Date("2026-03-01T00:00:00Z");
const fakeCost: CostOf = async () => ({ usd: 0.5, inputTokens: 100, outputTokens: 10, priced: true });
const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

let root: string;
let repo: ScratchRepo;
const heads: Record<string, string> = {};
const merges: Record<string, string> = {};

const commitIn = (files: Record<string, string | null>, message: string, branch = "main"): HistoryCommit => ({ files, message, branch });
const branchCommit = (name: string, files: Record<string, string>, from?: string): HistoryCommit => ({ files, message: `head ${name}`, branch: name, from });

/** main: base, then one squash commit per merged PR, with a revert and two fixes landing after them. */
function buildHistory(): void {
  const a34 = lines(10, "a").replace("a 3\na 4\n", "A3\nA4\n");
  const c5 = lines(10, "c").replace("c 5\n", "C5\n");
  const [, p1, p2, p3, p4, p5a, p5b, p6a, p6b, m1, , m2] = withHistory(repo.dir, [
    commitIn({ "src/a.ts": lines(10, "a"), "src/c.ts": lines(10, "c"), "src/d.ts": lines(5, "d"), "src/e.ts": lines(5, "e"), "README.md": "x\n" }, "Base"),
    branchCommit("p1", { "src/c.ts": c5 }, ":1"),
    branchCommit("p2", { "src/r.ts": "r\n" }, ":1"),
    branchCommit("p3", { "src/a.ts": a34 }, ":1"),
    branchCommit("p4", { "src/c.ts": lines(10, "c").replace("c 9\n", "C9\n") }, ":1"),
    branchCommit("p5", { "src/n5.ts": "n\n" }, ":1"),
    branchCommit("p5", { "src/d.ts": "fixed\n" }),
    branchCommit("p6", { "src/e.ts": "changed\n" }, ":1"),
    branchCommit("p6", { "README.md": "y\n" }),
    commitIn({ "src/c.ts": c5 }, "Change c five (#1)"),
    commitIn({ "src/c.ts": c5.replace("c 10\n", "C10\n") }, "Fix c ten"),
    commitIn({ "src/r.ts": "r\n" }, "Add r (#2)"),
  ]);
  Object.assign(heads, { p1, p2, p3, p4, p5a, p5b, p6a, p6b });
  Object.assign(merges, { p1: m1, p2: m2 });
  // The revert names the sha it reverts, so it goes in after that sha is known.
  const [, p3Merge, , p4Merge, p5Merge] = withHistory(repo.dir, [
    commitIn({ "src/r.ts": null }, `Revert "Add r (#2)"\n\nThis reverts commit ${m2}.`),
    commitIn({ "src/a.ts": a34 }, "Change a (#3)"),
    commitIn({ "src/a.ts": a34.replace("A3\n", "AA3\n") }, "Fix a three"),
    commitIn({ "src/c.ts": c5.replace("c 10\n", "C10\n").replace("c 9\n", "C9\n") }, "Change c nine (#4)"),
    commitIn({ "src/n5.ts": "n\n", "src/d.ts": "fixed\n" }, "Add n5 (#5)"),
  ]);
  Object.assign(merges, { p3: p3Merge, p4: p4Merge, p5: p5Merge });
}

const source = { path: "/transcripts/r.jsonl", namespace: "test" };

function verdict(head: string, word: "MERGE" | "FIX_FIRST", at: string, text = "", options: Partial<FixtureStep> & { late?: boolean } = {}): FixtureStep {
  const family = options.late ? "sh-late-verdict" : "sh-await-verdict";
  const result = { kind: "verdict", head, verdict: word, text, reviewerProfile: "reviewer", reviewer: { agentId: "a1", sessionId: "s1" }, locator: { source } };
  return { key: `${family}:${head}:0`, completedAt: at, result, ...(options.shape && { shape: options.shape }) };
}

const dispatched = (head: string, startedAt: string): FixtureStep => ({
  key: `sh-review:${head}:0`,
  completedAt: startedAt,
  result: { kind: "dispatched", head, startedAt: Date.parse(startedAt) },
});

const landed = (pr: string, head = pr): FixtureStep => ({ key: "sh-landed:0", completedAt: "2026-01-12T00:00:00Z", result: { headSha: heads[head], mergeSha: merges[pr] } });

function runs(): FixtureRun[] {
  const run = (id: string, pr: number, steps: FixtureStep[], kind?: string): FixtureRun => ({ id, repo: REPO, pr, steps, ...(kind && { kind }) });
  const p = (key: string) => heads[key] ?? "";
  return [
    // PR 1's head is recorded three times: on time, late (stored only under `data`), and by a replay run.
    run("r1", 1, [
      dispatched(p("p1"), "2026-01-02T00:59:00Z"),
      verdict(p("p1"), "MERGE", "2026-01-02T01:00:00Z"),
      verdict(p("p1"), "MERGE", "2026-01-02T02:00:00Z", "", { late: true, shape: "data-only" }),
      landed("p1"),
    ]),
    run("r1b", 1, [verdict(p("p1"), "MERGE", "2026-01-02T01:30:00Z")]),
    run("r2", 2, [verdict(p("p2"), "MERGE", "2026-01-02T01:00:00Z", "", { shape: "output-object" }), landed("p2")]),
    run("r3", 3, [verdict(p("p3"), "MERGE", "2026-01-02T01:00:00Z")]),
    run("r4", 4, [verdict(p("p4"), "MERGE", "2026-01-02T01:00:00Z"), landed("p4"), { key: "sh-main-ci:0", completedAt: "2026-01-10T01:00:00Z", result: { mergeSha: merges.p4, verdict: "red" } }], "security"),
    run("r5", 5, [verdict(p("p5a"), "FIX_FIRST", "2026-01-02T01:00:00Z", "Blocking: `d.ts:3` drops a row.\nVerdict: FIX_FIRST"), verdict(p("p5b"), "MERGE", "2026-01-03T01:00:00Z"), landed("p5", "p5b")]),
    run("r6", 6, [verdict(p("p6a"), "FIX_FIRST", "2026-01-02T01:00:00Z", "See src/e.ts:2 for the bug.\nCloser: no"), verdict(p("p6b"), "MERGE", "2026-01-03T01:00:00Z")]),
    run("r7", 7, [verdict("7".repeat(40), "FIX_FIRST", "2026-01-02T01:00:00Z", "`src/a.ts` is wrong")]),
    run("r8", 8, [verdict("8".repeat(40), "FIX_FIRST", "2026-01-02T01:00:00Z", "`src/a.ts` is wrong")]),
    run("r10", 10, [verdict("a".repeat(40), "FIX_FIRST", "2026-01-02T01:00:00Z", "`src/a.ts` is wrong")]),
    run("r11", 11, [verdict("b".repeat(40), "FIX_FIRST", "2026-01-02T01:00:00Z", "`src/a.ts` is wrong")]),
    run("r9", 9, [verdict("9".repeat(40), "MERGE", "2026-02-25T00:00:00Z")]),
  ];
}

const gates: FixtureGate[] = [
  { runId: "r7", decision: "merge", headSha: "7".repeat(40), reason: "risk accepted for the demo" },
  { runId: "r8", decision: "merge", headSha: "8".repeat(40), reason: null },
  { runId: "r10", decision: "merge", headSha: "a".repeat(40), reason: "merged from my phone", resolverClass: "owner-remote" },
  { runId: "r11", decision: "merge", headSha: "b".repeat(40), reason: "a coordinator merged it", resolverClass: "coordinator" },
];

let rows: CorpusRow[];
const rowAt = (pr: number, head = rows.find((row) => row.pr === pr)?.head) => rows.find((row) => row.pr === pr && row.head === head);

// buildCorpus runs dozens of git reads of its own, which on a loaded CI runner can outrun vitest's 10 s default (TP-3978).
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "corpus-fixture-"));
  repo = scratchRepo(join(root, "widgets"));
  buildHistory();
  writeFactoryDb(join(root, "factory.sqlite3"), runs(), gates);
  rows = await buildCorpus({ dbPath: join(root, "factory.sqlite3"), clones: new Map([[REPO.toLowerCase(), repo.dir]]), mainRef: "main", now: NOW, costOf: fakeCost });
}, 60_000);

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("reading the factory database", () => {
  it("leaves a copy of the database byte-for-byte unchanged", async () => {
    const copy = join(root, "copy.sqlite3");
    copyFileSync(join(root, "factory.sqlite3"), copy);
    const before = sha256(copy);

    const copied = await buildCorpus({ dbPath: copy, clones: new Map(), now: NOW, costOf: fakeCost });

    expect(copied).toHaveLength(rows.length);
    expect(sha256(copy)).toBe(before);
  });

  it("opens through a mode=ro URI that refuses writes", () => {
    const db = new DatabaseSync(readOnlyUri(join(root, "factory.sqlite3")));
    expect(() => db.exec("delete from workflow_run")).toThrow(/readonly/);
    db.close();
  });

  it("keeps one row per (repo, pr, head) across replays, iterations and step shapes", () => {
    expect(rows).toHaveLength(13);
    expect(rows.filter((row) => row.pr === 1)).toHaveLength(1);
    expect(rowAt(1)?.step).toBe("late");
    expect(rowAt(2)?.verdict).toBe("MERGE");
  });
});

describe("row fields", () => {
  it("carries the reviewer, the registration, cost and dispatch-to-verdict latency", () => {
    const row = rowAt(1);
    expect(row?.reviewer).toEqual({ profile: "reviewer", agentId: "a1", sessionId: "s1" });
    expect(row?.task).toBe("T/1");
    expect(row?.cost?.usd).toBe(0.5);
    expect(row?.latencyMs).toBe(3_660_000);
  });

  it("recomputes class from the head's diff with classifyPr", () => {
    expect(rowAt(3)).toMatchObject({ class: "standard", touches: ["untested"] });
    expect(rowAt(4)?.class).toBe("g10");
    expect(rowAt(7)?.class).toBeNull();
  });

  it("keeps FIX_FIRST findings, the paths they cite and the Closer line", () => {
    expect(rowAt(5, heads.p5a)?.citedPaths).toEqual(["d.ts"]);
    expect(rowAt(6, heads.p6a)).toMatchObject({ citedPaths: ["src/e.ts"], closer: "no", nextHead: heads.p6b });
    expect(rowAt(1)?.findings).toBeNull();
  });
});

describe("label rules", () => {
  it("a merged MERGE with no revert, red main or overlapping fix is clean", () => {
    expect(rowAt(1)).toMatchObject({ label: "clean", labels: { revert: false, "main-red": false, "later-fix": false } });
  });

  it("a MERGE whose merge commit was reverted escaped", () => {
    expect(rowAt(2)).toMatchObject({ label: "escaped", labels: { revert: true } });
  });

  it("a MERGE followed within 14 days by a fix over the lines it wrote escaped", () => {
    expect(rowAt(3)).toMatchObject({ label: "escaped", labels: { "later-fix": true, revert: false } });
  });

  it("a MERGE whose post-merge main read was red escaped", () => {
    expect(rowAt(4)).toMatchObject({ label: "escaped", labels: { "main-red": true } });
  });

  it("a FIX_FIRST whose next head changed a cited path was caught", () => {
    expect(rowAt(5, heads.p5a)).toMatchObject({ label: "caught", labels: { "fixer-changed-cited-paths": true } });
    expect(rowAt(5, heads.p5b)?.label).toBe("clean");
  });

  it("a FIX_FIRST whose next head changed nothing it cited was a false block", () => {
    expect(rowAt(6, heads.p6a)).toMatchObject({ label: "false-block", labels: { "fixer-changed-cited-paths": false } });
  });

  it("a MERGE whose PR never merged is unresolved", () => {
    expect(rowAt(6, heads.p6b)).toMatchObject({ label: "unresolved", mergeSha: null });
  });

  it("finds a merge Shepherd did not land by its squash subject on main", () => {
    expect(rowAt(3)?.mergeSha).toBe(merges.p3);
  });

  it("an owner merge over a FIX_FIRST is a false block when the owner gave a reason, and pending when not", () => {
    expect(rowAt(7)).toMatchObject({ label: "false-block", labels: { "owner-override": true }, overrideReason: "risk accepted for the demo" });
    expect(rowAt(8)).toMatchObject({ label: "pending", labels: { "owner-override": true } });
  });

  it("reads an override the owner resolved from Matrix, and not one a coordinator resolved", () => {
    expect(rowAt(10)).toMatchObject({ label: "false-block", labels: { "owner-override": true }, overrideReason: "merged from my phone" });
    expect(rowAt(11)).toMatchObject({ labels: { "owner-override": false }, overrideReason: null });
  });

  it("does not read a missing red record as green for a merge Shepherd did not land", () => {
    expect(rowAt(3)?.labels["main-red"]).toBeNull();
    expect(rowAt(1)?.labels["main-red"]).toBe(false);
  });

  it("a verdict younger than 14 days is pending", () => {
    expect(rowAt(9)?.label).toBe("pending");
  });
});
