import { describe, expect, it } from "vitest";
import { buildCorpus, sizeOf, stratifiedQueue, type ImplementCandidate } from "./corpus.js";
import type { CorpusSources, MainMerge, NumstatLine, Registration, TaskFile } from "./sources.js";

const sha = (n: number): string => n.toString(16).padStart(40, "0");
const options = { mergedSince: "2026-10-01", repo: "demo" };
const goodDiff: NumstatLine[] = [
  { path: "products/factory/src/cap.ts", changed: 40 },
  { path: "products/factory/src/cap.test.ts", changed: 30 },
  { path: ".changeset/cap.md", changed: 5 },
];

interface Fixture {
  registrations: Registration[];
  merges: MainMerge[];
  tasks: Record<string, TaskFile>;
  diffs: Record<number, NumstatLine[]>;
}

const registration = (pr: number, task: string, kind = "correctness"): Registration => ({ pr, task: `demo/${task}`, kind, createdAt: "2026-10-05T00:00:00Z" });
const merge = (pr: number, mergedAt = "2026-10-06T00:00:00Z"): MainMerge => ({ pr, sha: sha(pr * 2 + 1), parent: sha(pr * 2), mergedAt });
const task = (fields: Partial<TaskFile> = {}): TaskFile => ({ title: "Cap the retries", doneWhen: "the client stops after three", estimate: 1, ...fields });

function fakeSources(fixture: Fixture): CorpusSources {
  return {
    registrations: () => fixture.registrations,
    mainMerges: async () => fixture.merges,
    task: (id) => fixture.tasks[id],
    numstat: async (entry) => fixture.diffs[entry.pr] ?? goodDiff,
  };
}

async function reasonFor(fixture: Partial<Fixture>): Promise<string | undefined> {
  const full = { registrations: [registration(10, "TP-1")], merges: [merge(10)], tasks: { "TP-1": task() }, diffs: {}, ...fixture };
  const corpus = await buildCorpus(fakeSources(full), options);
  return corpus.skipped[0]?.reason;
}

describe("corpus join", () => {
  it("builds a corpus row for an eligible PR, with class from the Shepherd kind and base at the merge's parent", async () => {
    const corpus = await buildCorpus(fakeSources({ registrations: [registration(10, "TP-1", "feature")], merges: [merge(10)], tasks: { "TP-1": task() }, diffs: {} }), options);

    expect(corpus.skipped).toEqual([]);
    const [candidate] = corpus.eligible;
    expect(candidate?.row).toMatchObject({ case_id: "demo-pr10", repo: "demo", pr_number: 10, class: "feature", base_commit: sha(20), merge_commit: sha(21), task_ids: ["TP-1"] });
    expect(candidate?.row.brief_text).toBe("Task: Cap the retries\nDone when: the client stops after three");
    expect(candidate).toMatchObject({ size: "S", pkg: "products/factory", pkgGroup: "factory", changedLines: 75, nonTestLines: 40 });
  });

  it("skips a registered PR with no (#N) merge on main", async () => {
    expect(await reasonFor({ merges: [merge(11)] })).toBe("not-on-main");
  });

  it("skips a merged PR whose task has no task file", async () => {
    expect(await reasonFor({ tasks: {} })).toBe("no-task-file");
  });

  it.each<[string, Partial<Fixture>]>([
    ["merged-before-window", { merges: [merge(10, "2026-09-30T23:00:00Z")] }],
    ["kind-test-only", { registrations: [registration(10, "TP-1", "test-only")] }],
    ["no-done-when", { tasks: { "TP-1": task({ doneWhen: null }) } }],
    ["no-test-change", { diffs: { 10: [{ path: "products/factory/src/cap.ts", changed: 4 }] } }],
    ["test-only", { diffs: { 10: [{ path: "products/factory/src/cap.test.ts", changed: 4 }] } }],
    ["over-600-lines", { diffs: { 10: [...goodDiff, { path: "products/factory/src/big.ts", changed: 600 }] } }],
    ["not-one-package", { diffs: { 10: [...goodDiff, { path: "packages/pm/src/x.ts", changed: 1 }] } }],
    ["size-L", { tasks: { "TP-1": task({ estimate: 5 }) } }],
    ["brief-leaks-history", { tasks: { "TP-1": task({ doneWhen: "closed by Shepherd" }) } }],
    ["not-a-task", { registrations: [registration(10, "version-packages")] }],
  ])("records %s as the skip reason", async (reason, fixture) => {
    expect(await reasonFor(fixture)).toBe(reason);
  });

  it("joins the latest registration of a re-registered PR", async () => {
    const first = registration(10, "TP-1", "refactor");
    const later = { ...registration(10, "TP-1", "feature"), createdAt: "2026-10-09T00:00:00Z" };

    const corpus = await buildCorpus(fakeSources({ registrations: [later, first], merges: [merge(10)], tasks: { "TP-1": task() }, diffs: {} }), options);

    expect(corpus.eligible.map((candidate) => candidate.kind)).toEqual(["feature"]);
  });
});

describe("size band", () => {
  it.each<[number | null, number, string]>([
    [1.5, 900, "S"],
    [2, 10, "M"],
    [3, 10, "M"],
    [3.5, 10, "L"],
    [null, 150, "S"],
    [null, 151, "M"],
    [null, 400, "M"],
    [null, 401, "L"],
  ])("estimate %s with %s changed lines is %s", (estimate, lines, size) => {
    expect(sizeOf(estimate, lines)).toBe(size);
  });
});

const candidate = (id: string, kind: ImplementCandidate["kind"], size: ImplementCandidate["size"] = "S"): ImplementCandidate =>
  ({ row: { case_id: id }, kind, size, pkgGroup: "other" }) as ImplementCandidate;

describe("stratified queue", () => {
  it("takes one candidate from each stratum per round before a second from any", () => {
    const pool = [candidate("c1", "correctness"), candidate("c2", "correctness"), candidate("c3", "correctness"), candidate("f1", "feature"), candidate("r1", "refactor", "M")];

    const kinds = stratifiedQueue(pool, "seed").map((entry) => `${entry.kind}/${entry.size}`);

    expect(kinds.slice(0, 3)).toEqual(["correctness/S", "feature/S", "refactor/M"]);
    expect(kinds).toHaveLength(5);
  });

  it("keeps one order for a seed and reshuffles a stratum for another", () => {
    const pool = Array.from({ length: 12 }, (_, index) => candidate(`c${index}`, "correctness"));
    const order = (seed: string) => stratifiedQueue(pool, seed).map((entry) => entry.row.case_id);

    expect(order("a")).toEqual(order("a"));
    expect(order("a")).not.toEqual(order("b"));
  });
});
