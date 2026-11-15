import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gate, HEAD, REPO } from "./pr-fakes.test-helpers.js";
import { autoBriefTargets, briefDir, prChangedFiles, runPrVideoTrigger, shepherdWaiting, writeBrief, type BriefTarget, type StartBrief } from "./trigger.js";

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function dataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pr-trigger-"));
  temps.push(dir);
  return dir;
}

function recordingStart(): StartBrief & { started: BriefTarget[] } {
  const started: BriefTarget[] = [];
  return Object.assign(async (target: BriefTarget) => (started.push(target), "started" as const), { started });
}

const waiting = (owner: ReturnType<typeof gate>[], seat: ReturnType<typeof gate>[] = []) => ({ owner, seat });

describe("autoBriefTargets", () => {
  it("picks an owner gate held at the visual gate on the gate's current head", () => {
    expect(autoBriefTargets(waiting([gate()]))).toEqual([{ repo: REPO, number: 7, head: HEAD, gateId: "run-1:approve-merge" }]);
  });

  it.each([
    ["an unheld owner gate", gate({ held: null })],
    ["an owner gate under another hold class", gate({ held: "owner-asked: look at the copy" })],
    ["a hold that only mentions the visual gate", gate({ held: "stalled: waiting behind visual-gate2; TP-1" })],
    ["a gate whose head moved on", gate({ headIsCurrent: false })],
    ["a gate with no PR", gate({ pr: null })],
    ["a gate with no head", gate({ head: null })],
  ])("skips %s", (_name, owner) => {
    expect(autoBriefTargets(waiting([owner]))).toEqual([]);
  });

  it("skips a seat gate even when it carries the visual hold", () => {
    expect(autoBriefTargets(waiting([], [gate({ stepId: "ci-failed" })]))).toEqual([]);
  });

  it("starts one brief per PR when two of its gates wait", () => {
    expect(autoBriefTargets(waiting([gate(), gate({ gateId: "run-1:approve-merge-2" })]))).toHaveLength(1);
  });
});

describe("runPrVideoTrigger", () => {
  it("never auto-starts a PR that is not held at the visual gate", async () => {
    const start = recordingStart();
    const others = waiting([gate({ held: null }), gate({ pr: 8, held: "owner-asked: copy" }), gate({ pr: 9, held: "g10-review: big diff" })], [gate({ pr: 10, stepId: "ci-failed", held: null })]);

    const rows = await runPrVideoTrigger({ dataDir: await dataDir(), readWaiting: async () => others, start });

    expect(rows).toEqual([]);
    expect(start.started).toEqual([]);
  });

  it("starts a visual-gate PR, and only that one, among other waiting PRs", async () => {
    const start = recordingStart();
    const mixed = waiting([gate({ pr: 8, held: null }), gate()]);

    const rows = await runPrVideoTrigger({ dataDir: await dataDir(), readWaiting: async () => mixed, start });

    expect(rows.map((r) => [r.pr, r.outcome])).toEqual([[`${REPO}#7`, "started"]]);
    expect(start.started.map((t) => t.number)).toEqual([7]);
  });

  it("starts nothing on a dry run and reports what would start", async () => {
    const start = recordingStart();

    const rows = await runPrVideoTrigger({ dataDir: await dataDir(), readWaiting: async () => waiting([gate()]), start, dryRun: true });

    expect(rows.map((r) => r.outcome)).toEqual(["would-start"]);
    expect(start.started).toEqual([]);
  });

  it("refuses a waiting list that is not Shepherd's shape rather than guessing", async () => {
    const start = recordingStart();

    await expect(runPrVideoTrigger({ dataDir: await dataDir(), readWaiting: async () => [{ pr: 7 }], start })).rejects.toThrow();
    expect(start.started).toEqual([]);
  });
});

describe("runPrVideoTrigger head re-check", () => {
  it("re-reads the gates right before a start and skips a head that moved since the sweep's first read", async () => {
    const start = recordingStart();
    const reads = [waiting([gate(), gate({ pr: 8 })]), waiting([gate(), gate({ pr: 8 })]), waiting([gate(), gate({ pr: 8, head: "b".repeat(40) })])];

    const rows = await runPrVideoTrigger({ dataDir: await dataDir(), readWaiting: async () => reads.shift(), start });

    expect(rows.map((r) => [r.pr, r.outcome])).toEqual([[`${REPO}#7`, "started"], [`${REPO}#8`, "moved"]]);
    expect(start.started.map((t) => t.number)).toEqual([7]);
  });

  it("skips a head whose gate Shepherd no longer calls current", async () => {
    const start = recordingStart();
    const reads = [waiting([gate()]), waiting([gate({ headIsCurrent: false })])];

    const rows = await runPrVideoTrigger({ dataDir: await dataDir(), readWaiting: async () => reads.shift(), start });

    expect(rows.map((r) => r.outcome)).toEqual(["moved"]);
    expect(start.started).toEqual([]);
  });
});

const OTHER_HEAD = "c".repeat(40);
const prRow = (overrides: Record<string, unknown> = {}) => ({ repo: REPO, number: 11, headSha: OTHER_HEAD, state: "open", draft: false, ...overrides });

function visualSweep(prs: unknown[], files: Record<number, string[]>, owner: ReturnType<typeof gate>[] = []) {
  const start = recordingStart();
  const run = async (extra: { dryRun?: boolean; dir?: string } = {}) =>
    runPrVideoTrigger({
      dataDir: extra.dir ?? (await dataDir()),
      readWaiting: async () => waiting(owner),
      readPrs: async () => prs,
      readFiles: async (ref) => files[ref.number] ?? [],
      visualPaths: ["products/*/src/ui/**", "**/*.css"],
      start,
      ...(extra.dryRun ? { dryRun: true } : {}),
    });
  return { start, run };
}

describe("runPrVideoTrigger --visual-path", () => {
  it("targets an open PR with no owner gate whose changed file matches a visual glob", async () => {
    const { start, run } = visualSweep([prRow()], { 11: ["products/app/src/ui/panel.tsx"] });

    const rows = await run();

    expect(rows.map((r) => [r.pr, r.head, r.outcome])).toEqual([[`${REPO}#11`, OTHER_HEAD, "started"]]);
    expect(start.started.map((t) => t.number)).toEqual([11]);
  });

  it("matches a glob with a leading ** against a root-level file", async () => {
    const { run } = visualSweep([prRow()], { 11: ["theme.css"] });

    expect((await run()).map((r) => r.outcome)).toEqual(["started"]);
  });

  it("skips a PR whose changed files all miss the globs", async () => {
    const { start, run } = visualSweep([prRow()], { 11: ["products/app/src/core/engine.ts", "README.md"] });

    expect(await run()).toEqual([]);
    expect(start.started).toEqual([]);
  });

  it("skips a draft PR and a merged PR even when they touch a visual path", async () => {
    const { run } = visualSweep([prRow({ draft: true }), prRow({ number: 12, state: "merged" })], { 11: ["a.css"], 12: ["a.css"] });

    expect(await run()).toEqual([]);
  });

  it("skips a PR row with no head", async () => {
    const { run } = visualSweep([prRow({ headSha: null })], { 11: ["a.css"] });

    expect(await run()).toEqual([]);
  });

  it("reports a head already briefed as already and starts nothing", async () => {
    const dir = await dataDir();
    await writeBrief(briefDir(dir, { repo: REPO, number: 11, head: OTHER_HEAD }), { repo: REPO, number: 11, head: OTHER_HEAD, gateId: "visual-path" });
    const again = visualSweep([prRow()], { 11: ["a.css"] });

    const rows = await again.run({ dir });

    expect(rows.map((r) => r.outcome)).toEqual(["already"]);
    expect(again.start.started).toEqual([]);
  });

  it("starts a PR found by both the owner gate and the visual path once", async () => {
    const { start, run } = visualSweep([prRow({ number: 7, headSha: HEAD })], { 7: ["a.css"] }, [gate()]);

    const rows = await run();

    expect(rows.map((r) => [r.pr, r.outcome])).toEqual([[`${REPO}#7`, "started"]]);
    expect(start.started).toHaveLength(1);
  });

  it("reads no PR list and no files when no --visual-path is given", async () => {
    const start = recordingStart();
    const rows = await runPrVideoTrigger({
      dataDir: await dataDir(),
      readWaiting: async () => waiting([]),
      readPrs: async () => {
        throw new Error("must not read prs");
      },
      start,
    });

    expect(rows).toEqual([]);
  });

  it("skips a PR whose head moved between the sweep's read and its start", async () => {
    const start = recordingStart();
    const reads = [[prRow()], [prRow({ headSha: "d".repeat(40) })]];

    const rows = await runPrVideoTrigger({
      dataDir: await dataDir(),
      readWaiting: async () => waiting([]),
      readPrs: async () => reads.shift(),
      readFiles: async () => ["a.css"],
      visualPaths: ["**/*.css"],
      start,
    });

    expect(rows.map((r) => r.outcome)).toEqual(["moved"]);
    expect(start.started).toEqual([]);
  });
});

describe("prChangedFiles", () => {
  it("lists a PR's changed file names through gh pr diff --name-only", async () => {
    const calls: string[][] = [];
    const gh = async (args: readonly string[]) => (calls.push([...args]), "a.css\nsrc/b.ts\n");

    expect(await prChangedFiles({ repo: REPO, number: 11 }, gh)).toEqual(["a.css", "src/b.ts"]);
    expect(calls).toEqual([["pr", "diff", "11", "--repo", REPO, "--name-only"]]);
  });
});

describe("shepherdWaiting", () => {
  const exitWith = (code: number, stdout: string) => async () => {
    throw Object.assign(new Error(`titan-factory exited ${code}`), { code, stdout });
  };

  it("reads the list from stdout when an overdue owner gate makes it exit 1", async () => {
    const listed = { owner: [gate()], seat: [] };

    expect(await shepherdWaiting(undefined, exitWith(1, JSON.stringify(listed)))).toEqual(listed);
  });

  it("passes --port through and parses a clean exit", async () => {
    const calls: string[][] = [];
    const exec = async (args: string[]) => (calls.push(args), { stdout: '{"owner":[],"seat":[]}' });

    expect(await shepherdWaiting(7411, exec)).toEqual({ owner: [], seat: [] });
    expect(calls).toEqual([["shepherd", "waiting", "--json", "--port", "7411"]]);
  });

  it.each([
    ["exit 1 with nothing on stdout", exitWith(1, "")],
    ["any other exit", exitWith(2, '{"owner":[],"seat":[]}')],
  ])("throws on %s", async (_name, exec) => {
    await expect(shepherdWaiting(undefined, exec)).rejects.toThrow(/exited/);
  });
});
