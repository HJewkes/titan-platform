import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkflowRun, WorkflowStatus } from "@titan-design/workflow";
import { afterEach, describe, expect, it } from "vitest";
import { openFactoryHost } from "../host.js";
import { chorePruning, LAUNCH_GRACE_MS, sweepFinalRuns } from "./chore-prune.js";
import { choreFiles, writeJson, type ChoreFiles, type ChorePorts } from "./post-merge-chore.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const NOW = Date.parse("2026-03-01T12:00:00.000Z");
const RESULT = { exitCode: 0, signal: null, timedOut: false, stdoutTail: "", stderrTail: "" };

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "factory-sweep-"));
  dirs.push(dir);
  return dir;
}

function fakePorts(): { ports: ChorePorts; setAlive(alive: boolean): void } {
  let alive = true;
  return { ports: { dir: tempDir(), launch: async (files) => ({ unit: files.unit }), alive: async () => alive }, setAlive: (next) => void (alive = next) };
}

interface SetOptions {
  handle?: boolean;
  startedMsAgo?: number;
  result?: boolean;
}

/** One chore's files for `runId`, in the shapes `launchChore` and its wrapper write them. */
function chore(dir: string, runId: string, options: SetOptions = {}): ChoreFiles {
  const files = choreFiles(dir, `workflow:${runId}:post-merge:0:0`);
  const started = new Date(NOW - (options.startedMsAgo ?? 10 * LAUNCH_GRACE_MS)).toISOString();
  writeJson(files.spec, {});
  writeJson(files.marker, { started, step: { runId, stepId: "post-merge", iteration: 0, attempt: 0 }, ...(options.handle === false ? {} : { handle: { unit: files.unit } }) });
  if (options.result) writeJson(files.result, RESULT);
  return files;
}

const runsWith = (statuses: Record<string, WorkflowStatus>) => ({ get: (id: string) => (statuses[id] ? { status: statuses[id] } : undefined) });
const kept = (files: ChoreFiles): boolean => existsSync(files.marker) && existsSync(files.spec);

describe("sweepFinalRuns", () => {
  it("sweeps a cancelled run's finished chore files", async () => {
    const { ports } = fakePorts();
    const files = chore(ports.dir, "run-a", { result: true });

    const swept = await sweepFinalRuns(ports, runsWith({ "run-a": "cancelled" }), NOW);

    expect(swept).toHaveLength(1);
    expect(readdirSync(ports.dir)).toEqual([]);
    expect(existsSync(files.marker)).toBe(false);
  });

  it("keeps a failed run's still-running chore, and sweeps it on the next pass once the chore exits", async () => {
    const { ports, setAlive } = fakePorts();
    const files = chore(ports.dir, "run-b");
    const runs = runsWith({ "run-b": "failed" });

    await sweepFinalRuns(ports, runs, NOW);
    const whileRunning = kept(files);
    setAlive(false);
    await sweepFinalRuns(ports, runs, NOW);

    expect(whileRunning).toBe(true);
    expect(readdirSync(ports.dir)).toEqual([]);
  });

  it.each<WorkflowStatus>(["recovery_required", "running", "paused", "cancelling"])("keeps the files of a %s run whose chore is gone", async (status) => {
    const { ports, setAlive } = fakePorts();
    setAlive(false);
    const files = chore(ports.dir, "run-c");

    await sweepFinalRuns(ports, runsWith({ "run-c": status }), NOW);

    expect(kept(files)).toBe(true);
  });

  it("keeps a handle-less marker inside the launch grace and sweeps it after", async () => {
    const { ports } = fakePorts();
    const young = chore(ports.dir, "run-d1", { handle: false, startedMsAgo: LAUNCH_GRACE_MS / 6 });
    const old = chore(ports.dir, "run-d2", { handle: false, startedMsAgo: 2 * LAUNCH_GRACE_MS });

    await sweepFinalRuns(ports, runsWith({ "run-d1": "cancelled", "run-d2": "cancelled" }), NOW);

    expect(kept(young)).toBe(true);
    expect(existsSync(old.marker)).toBe(false);
  });

  it("leaves a run absent from the store and an unreadable marker alone", async () => {
    const { ports } = fakePorts();
    const absent = chore(ports.dir, "run-gone", { result: true });
    const broken = choreFiles(ports.dir, "workflow:run-broken:post-merge:0:0");
    writeFileSync(broken.marker, "not json");

    await sweepFinalRuns(ports, runsWith({}), NOW);

    expect(kept(absent)).toBe(true);
    expect(existsSync(broken.marker)).toBe(true);
  });
});

function seededRun(id: string, status: WorkflowStatus): WorkflowRun {
  return { id, workflowName: "land-pr", params: {}, status, currentStep: null, stepResults: {}, activeSteps: {}, revision: 0, ownerGeneration: 0, startedAt: "2026-01-01T00:00:00.000Z", completedAt: null, error: null };
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 20));

describe("chorePruning final-run sweep", () => {
  it("sweeps at host bind, and again on a later final event once a running chore has exited", async () => {
    const { ports, setAlive } = fakePorts();
    const dbPath = join(tempDir(), "factory.sqlite3");
    const seeding = openFactoryHost({ dbPath, workflows: [], routes: [] });
    seeding.runs.create(seededRun("run-e", "cancelled"));
    seeding.runs.create(seededRun("run-f", "recovery_required"));
    seeding.runs.create(seededRun("run-g", "failed"));
    seeding.close();
    const finished = chore(ports.dir, "run-e", { result: true });
    const live = chore(ports.dir, "run-g");
    const parked = chore(ports.dir, "run-f", { result: true });
    const pruning = chorePruning(ports, () => NOW);

    const host = openFactoryHost({ dbPath, workflows: [], routes: Object.assign([], pruning) });
    await settle();
    const afterBind = [existsSync(finished.marker), kept(live), kept(parked)];
    setAlive(false);
    pruning.onEvent?.({ type: "workflow_cancelled", runId: "run-x", reason: "test" });
    await settle();
    host.close();

    expect(afterBind).toEqual([false, true, true]);
    expect(existsSync(live.marker)).toBe(false);
    expect(kept(parked)).toBe(true);
  });
});
