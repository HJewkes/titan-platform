import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeGitHub, githubPort, successRun, type FakeGitHub } from "@titan-design/github";
import type { RecoverableActiveStep, StepRoute } from "@titan-design/workflow";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { PostMergeConfig } from "../config.js";
import { crashAt } from "../test-support/crash.js";
import { H1, REPO, answerPendingGate } from "../test-support/land.js";
import { landPrRoutes, landPrWorkflow } from "./land-pr.js";
import { postMergeRoute } from "./post-merge.js";
import { choreFiles, writeJson, type ChoreFiles, type ChorePorts } from "./post-merge-chore.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const CONFIG: PostMergeConfig = { argv: ["chore", "--prune"] };
const REQUEST_KEY = "workflow:run-1:post-merge:0:0";
const EXITED_3 = { exitCode: 3, signal: null, timedOut: false, stdoutTail: "pruned", stderrTail: "" };
const RecordedOutput = z.looseObject({ kind: z.literal("land.post-merge"), result: z.looseObject({}) });

interface FakeChores {
  ports: ChorePorts;
  launched: ChoreFiles[];
  setAlive(alive: boolean): void;
}

/** Launches nothing real: `onLaunch` stands in for the wrapper, and liveness is whatever the test sets. */
function fakeChores(onLaunch: (files: ChoreFiles) => void = () => undefined): FakeChores {
  const dir = mkdtempSync(join(tmpdir(), "factory-chores-"));
  dirs.push(dir);
  const launched: ChoreFiles[] = [];
  let alive = true;
  const ports: ChorePorts = {
    dir,
    pollMs: 5,
    launch: async (files) => (launched.push(files), onLaunch(files), { unit: files.unit }),
    alive: async () => alive,
  };
  return { ports, launched, setAlive: (next) => void (alive = next) };
}

function interrupted(requestKey = REQUEST_KEY): RecoverableActiveStep {
  return { kind: "recoverable", stepId: "post-merge", iterKey: "post-merge:0", attempt: 0, startedAt: "2026-01-01T00:00:00.000Z", executionId: "exec-1", requestKey };
}

function startedMarker(chores: FakeChores, handle?: object): ChoreFiles {
  const files = choreFiles(chores.ports.dir, REQUEST_KEY);
  writeJson(files.marker, { started: "2026-01-01T00:00:00.000Z", step: { runId: "run-1", stepId: "post-merge", iteration: 0, attempt: 0 }, ...(handle ? { handle } : {}) });
  return files;
}

const reconcile = (route: StepRoute) => route.reconcile!(interrupted(), new AbortController().signal);

function recordedResult(output: string): unknown {
  return RecordedOutput.parse(JSON.parse(output)).result;
}

describe("post-merge reconcile after a restart", () => {
  it("is retry-safe with no post-merge command, since the step ran nothing", async () => {
    const outcome = await reconcile(postMergeRoute({}));

    expect(outcome).toMatchObject({ kind: "not_found", retrySafe: true });
  });

  it("is retry-safe when no chore marker exists, because the chore never started", async () => {
    const outcome = await reconcile(postMergeRoute({ postMerge: CONFIG, chores: fakeChores().ports }));

    expect(outcome).toMatchObject({ kind: "not_found", retrySafe: true });
  });

  it("reports a chore whose unit is still alive as running, and completes from the result file it writes later", async () => {
    const chores = fakeChores();
    const files = startedMarker(chores, { unit: "titan-factory-chore-test" });

    const outcome = await reconcile(postMergeRoute({ postMerge: CONFIG, chores: chores.ports }));
    if (outcome.kind !== "running") throw new Error(`expected running, got ${outcome.kind}`);
    writeJson(files.result, EXITED_3);
    const completed = await outcome.completion;

    expect(outcome.runnerRef).toBe("unit titan-factory-chore-test");
    if (completed.kind !== "succeeded") throw new Error(`expected succeeded, got ${completed.kind}`);
    expect(recordedResult(completed.output)).toEqual(EXITED_3);
  });

  it("records a finished chore as terminal with its exit, whether or not its unit is gone", async () => {
    const chores = fakeChores();
    chores.setAlive(false);
    const files = startedMarker(chores, { pid: 4242 });
    writeJson(files.result, EXITED_3);

    const outcome = await reconcile(postMergeRoute({ postMerge: CONFIG, chores: chores.ports }));

    if (outcome.kind !== "terminal" || outcome.outcome.kind !== "succeeded") throw new Error(`expected a succeeded terminal, got ${outcome.kind}`);
    expect(recordedResult(outcome.outcome.output)).toEqual(EXITED_3);
  });

  it("parks honestly as unknown when the marker names a chore that is gone and wrote no result", async () => {
    const chores = fakeChores();
    chores.setAlive(false);
    startedMarker(chores, { unit: "titan-factory-chore-test" });

    const outcome = await reconcile(postMergeRoute({ postMerge: CONFIG, chores: chores.ports }));

    expect(outcome).toMatchObject({ kind: "unknown", evidence: expect.stringContaining("wrote no result") });
  });

  it("parks as unknown when a restart caught the launch itself, before the marker named the chore", async () => {
    const chores = fakeChores();
    startedMarker(chores);

    const outcome = await reconcile(postMergeRoute({ postMerge: CONFIG, chores: chores.ports }));

    expect(outcome).toMatchObject({ kind: "unknown" });
  });

  it("still parks a chore run inside serve, which has no marker to read", async () => {
    const outcome = await reconcile(postMergeRoute({ postMerge: CONFIG }));

    expect(outcome).toMatchObject({ kind: "unknown" });
  });
});

/** One PR at H1 with green required checks, landed with the chore launched through `chores`. */
function world(chores: ChorePorts): { fake: FakeGitHub; routes: StepRoute[] } {
  const fake = fakeGitHub();
  fake.addPr({ headSha: H1 });
  fake.onGetPr = (pr) => fake.setRuns(pr.headSha, [successRun("validate", 1), successRun("dag-check", 2)]);
  let clock = 0;
  return { fake, routes: landPrRoutes({ port: githubPort(fake.wire), now: () => clock, sleep: async (ms) => void (clock += ms), postMerge: CONFIG, chores }) };
}

/** A serve killed once the post-merge step is active; the test plays the chore's wrapper on disk. */
async function killedAtPostMerge(chores: FakeChores) {
  const { fake, routes } = world(chores.ports);
  const dir = mkdtempSync(join(tmpdir(), "factory-post-merge-"));
  dirs.push(dir);
  const crash = crashAt({ dbPath: join(dir, "factory.sqlite3"), workflows: [landPrWorkflow()], routes, hangAt: "post-merge" });
  const runId = crash.crashed.runtime.start("land-pr", { repo: REPO, pr: "1" });
  const reached = crash.reached.then(() => true);
  const tick = () => new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5));
  do answerPendingGate(crash.crashed, runId, fake);
  while (!(await Promise.race([reached, tick()])));
  const active = crash.crashed.runtime.status(runId)?.activeSteps["post-merge"];
  if (active?.kind !== "recoverable") throw new Error("post-merge is not an active recoverable step");
  const files = choreFiles(chores.ports.dir, active.requestKey);
  writeJson(files.marker, { started: active.startedAt, step: { runId, stepId: "post-merge", iteration: 0, attempt: active.attempt }, handle: { unit: files.unit } });
  return { fake, routes, crash, runId, files };
}

describe("post-merge chore across a serve crash", () => {
  it("records the result a chore wrote while serve was down and completes the run without launching the chore again", async () => {
    const chores = fakeChores();
    const { fake, routes, crash, runId, files } = await killedAtPostMerge(chores);
    chores.setAlive(false);
    writeJson(files.result, EXITED_3);

    const successor = crash.takeOver(routes);
    await successor.resume();
    const run = await successor.runtime.wait(runId);
    crash.dispose();

    expect(run.status).toBe("completed");
    expect(chores.launched).toEqual([]);
    expect(fake.effects.merge).toBe(1);
  });

  it("waits on a chore still running in its own unit and completes the run once it writes its result", async () => {
    const chores = fakeChores();
    const { routes, crash, runId, files } = await killedAtPostMerge(chores);

    const successor = crash.takeOver(routes);
    await successor.adopt();
    const before = successor.runtime.status(runId)?.status;
    writeJson(files.result, EXITED_3);
    const run = await successor.runtime.wait(runId);
    crash.dispose();

    expect(before).toBe("running");
    expect(run.status).toBe("completed");
    expect(chores.launched).toEqual([]);
  });
});
