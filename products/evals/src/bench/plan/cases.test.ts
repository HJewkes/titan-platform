import { describe, expect, it } from "vitest";
import { briefLeaks, landingsByTask, multiPool, parseMainLog, singlePool, type MainCommit, type PlanCase, type Registration, type TaskRecord } from "./cases.js";
import { samplePlanCases } from "./sample.js";

const task = (id: string, extra: Partial<TaskRecord> = {}): TaskRecord => ({ id, title: `Do ${id}`, doneWhen: `${id} works`, status: "done", created: "2026-10-05 10:00:00+00:00", estimate: null, notes: "", ...extra });

const commit = (n: number, files: { path: string; lines: number }[], date = "2026-10-10"): MainCommit => ({
  sha: `m${n}`.padEnd(40, "0"),
  parent: `p${n}`.padEnd(40, "0"),
  date,
  subject: `Change ${n} (#${n})`,
  files,
});

const OPTIONS = { createdSince: "2026-10-01", mergedSince: "2026-10-01" };

function fixture() {
  const tasks = new Map(
    [
      task("TP-1"),
      task("TP-2", { title: "TP-1 S1: parser" }),
      task("TP-3", { notes: "Split from TP-1." }),
      task("TP-4", { estimate: 3 }),
      task("TP-5", { estimate: 1 }),
      task("TP-6", { title: "TP-9 S1: orphan" }),
    ].map((entry) => [entry.id, entry]),
  );
  const src = (pkg: string) => [{ path: `packages/${pkg}/src/x.ts`, lines: 100 }, { path: `packages/${pkg}/src/x.test.ts`, lines: 50 }];
  const commits = [commit(400, src("c")), commit(300, src("b"), "2026-10-09"), commit(200, [...src("a"), { path: "site/a.md", lines: 3 }], "2026-10-08"), commit(500, src("d"))].reverse();
  const registrations: Registration[] = [
    { pr: 200, taskId: "TP-2", kind: "feature" },
    { pr: 300, taskId: "TP-3", kind: "correctness" },
    { pr: 400, taskId: "TP-4", kind: "feature" },
    { pr: 500, taskId: "TP-5", kind: "feature" },
  ];
  return { tasks, landings: landingsByTask(commits, registrations, tasks) };
}

describe("pools", () => {
  it("makes a multi case from a parent whose title-prefixed and split-from children all landed", () => {
    const { tasks, landings } = fixture();

    const [multi, ...rest] = multiPool(tasks, landings, OPTIONS);

    expect(rest).toHaveLength(0);
    expect(multi).toMatchObject({ id: "TP-1", pool: "multi", slicesLanded: 2, baseSha: "p200".padEnd(40, "0"), packages: ["packages/a", "packages/b"], topDirs: ["packages", "site"] });
    expect(multi?.landed.map((entry) => entry.pr)).toEqual([200, 300]);
  });

  it("drops a multi parent with a child not done, or created before the cutoff", () => {
    const { tasks, landings } = fixture();
    const open = new Map(tasks).set("TP-3", task("TP-3", { notes: "Split from TP-1.", status: "in_progress" }));
    const old = new Map(tasks).set("TP-1", task("TP-1", { created: "2026-09-30 23:00:00+00:00" }));

    expect(multiPool(open, landings, OPTIONS)).toEqual([]);
    expect(multiPool(old, landings, OPTIONS)).toEqual([]);
  });

  it("keeps single-PR tasks of estimate 3 or more and drops smaller ones", () => {
    const { tasks, landings } = fixture();

    expect(singlePool(tasks, landings, OPTIONS).map((entry) => [entry.id, entry.slicesLanded])).toEqual([["TP-4", 1]]);
  });
});

describe("parseMainLog", () => {
  it("reads each first-parent commit with its first parent and numstat lines", () => {
    const log = `\x1e${"a".repeat(40)}\t${"b".repeat(40)} ${"c".repeat(40)}\t2026-10-02T01:00:00+00:00\tFix it (#12)\n\n3\t1\tpackages/a/x.ts\n-\t-\tbin.png\n`;

    expect(parseMainLog(log)).toEqual([{ sha: "a".repeat(40), parent: "b".repeat(40), date: "2026-10-02", subject: "Fix it (#12)", files: [{ path: "packages/a/x.ts", lines: 4 }, { path: "bin.png", lines: 0 }] }]);
  });
});

const planCase = (id: string, pool: PlanCase["pool"], kind: string, extra: Partial<PlanCase> = {}): PlanCase => ({
  id,
  hash: `h-${id}`,
  stratum: { pool, kind },
  title: `Task ${id}`,
  doneWhen: "it works",
  kind,
  pool,
  baseSha: "b".repeat(40),
  landed: [{ pr: 1234, mergeSha: "c".repeat(40), title: "x" }],
  slicesLanded: 1,
  packages: [],
  topDirs: [],
  ...extra,
});

describe("brief scrub", () => {
  it("rejects a brief that names a PR number", () => {
    expect(briefLeaks(planCase("TP-1", "single", "feature", { doneWhen: "the fix from #3540 holds" }))).toBe(true);
    expect(briefLeaks(planCase("TP-1", "single", "feature", { title: "Follow-up TP-12: tidy" }))).toBe(true);
    expect(briefLeaks(planCase("TP-1", "single", "feature"))).toBe(false);
  });

  it("replaces a rejected case with the next one in its stratum", () => {
    const leaky = planCase("TP-L", "single", "feature", { doneWhen: "closed by Shepherd" });
    const pools = { multi: [], single: [leaky, planCase("TP-A", "single", "feature"), planCase("TP-B", "single", "feature")] };

    const { queue, rejected } = samplePlanCases(pools, { multi: 0, single: 2 }, "seed-x");

    expect(queue.map((entry) => entry.id).sort()).toEqual(["TP-A", "TP-B"]);
    expect(rejected.map((entry) => entry.id)).toEqual(["TP-L"]);
  });
});

describe("samplePlanCases", () => {
  const many = (pool: PlanCase["pool"], kind: string, n: number) => Array.from({ length: n }, (_, index) => planCase(`${pool}-${kind}-${index}`, pool, kind));
  const pools = { multi: [...many("multi", "feature", 15), ...many("multi", "correctness", 9)], single: [...many("single", "feature", 30), ...many("single", "correctness", 10), ...many("single", "refactor", 5)] };

  it("draws 12 multi and 8 single, and every prefix of 2 or more holds both pools", () => {
    const { queue } = samplePlanCases(pools, { multi: 12, single: 8 }, "bench-2026-11");

    expect(queue).toHaveLength(20);
    for (let length = 2; length <= queue.length; length++) expect(new Set(queue.slice(0, length).map((entry) => entry.pool)).size).toBe(2);
    expect(queue.slice(0, 10).filter((entry) => entry.pool === "multi")).toHaveLength(6);
  });

  it("stratifies each pool by kind in proportion and is stable for a seed", () => {
    const first = samplePlanCases(pools, { multi: 12, single: 8 }, "bench-2026-11").queue;
    const kinds = (pool: string) => first.filter((entry) => entry.pool === pool).map((entry) => entry.kind);

    expect(kinds("multi").filter((kind) => kind === "feature")).toHaveLength(8);
    expect(kinds("single").filter((kind) => kind === "refactor")).toHaveLength(1);
    expect(samplePlanCases(pools, { multi: 12, single: 8 }, "bench-2026-11").queue.map((entry) => entry.id)).toEqual(first.map((entry) => entry.id));
  });
});
