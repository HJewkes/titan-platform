import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fakeEdges, fakeGh, gate, HEAD, REPO } from "./pr-fakes.test-helpers.js";
import { autoBriefTargets, briefDir, gatherStart, runPrVideoTrigger, type BriefTarget, type StartBrief } from "./trigger.js";

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

describe("gatherStart", () => {
  const sweep = async (dir: string, head = HEAD) =>
    runPrVideoTrigger({ dataDir: dir, readWaiting: async () => waiting([gate({ head })]), start: gatherStart(() => "/clone/widgets", { gh: fakeGh(), callEdges: fakeEdges() }) });

  it("writes a decision-brief brief.json and the gathered facts.jsonl", async () => {
    const dir = await dataDir();

    const [row] = await sweep(dir);

    expect(row?.outcome).toBe("started");
    expect(JSON.parse(await readFile(join(row!.dir, "brief.json"), "utf8"))).toMatchObject({ profile: "pr-overview", cut: "decision-brief", trigger: "visual-gate2", pr: `${REPO}#7`, head: HEAD });
    expect(existsSync(join(row!.dir, "facts.jsonl"))).toBe(true);
  });

  it("starts each head once: a second sweep finds the brief, a new head starts again", async () => {
    const dir = await dataDir();
    await sweep(dir);

    const again = await sweep(dir);
    const moved = await sweep(dir, "b".repeat(40));

    expect(again.map((r) => r.outcome)).toEqual(["already"]);
    expect(moved.map((r) => r.outcome)).toEqual(["started"]);
  });

  it("records E-NO-CLONE and reports refused when no clone is configured for the repo", async () => {
    const dir = await dataDir();
    const target = { repo: REPO, number: 7, head: HEAD, gateId: "g" };

    const outcome = await gatherStart(() => undefined)(target, briefDir(dir, target));

    expect(outcome).toBe("refused");
    expect(JSON.parse(await readFile(join(briefDir(dir, target), "gather.json"), "utf8")).diagnostics[0].code).toBe("E-NO-CLONE");
  });
});
