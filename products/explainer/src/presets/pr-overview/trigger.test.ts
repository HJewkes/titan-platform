import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gate, HEAD, REPO } from "./pr-fakes.test-helpers.js";
import { autoBriefTargets, runPrVideoTrigger, shepherdWaiting, type BriefTarget, type StartBrief } from "./trigger.js";

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
