import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUTORESEARCH_VALIDATE_WORKFLOW, AUTORESEARCH_WORKFLOW, BoundsSchema, TargetSchema } from "@titan-design/autoresearch";
import { EXIT, invokeCommand } from "@titan-design/registry";
import { partialFake } from "@titan-design/test-kit";
import type { StepResult, WorkflowRun, WorkflowStatus } from "@titan-design/workflow";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { FactoryHost } from "../host.js";
import type { FactoryContext } from "../registry.js";
import { arConfigFixture } from "../test-support/autoresearch.js";
import { AR_READ_COMMANDS, AR_WRITE_COMMANDS } from "./commands.js";
import { ideaDiff } from "./diff-read.js";
import { ownerIdeasPort } from "./inbox.js";
import { execGit } from "./ratchet.js";

/** A copy of the console's `ArDiffSchema`, not an import: a product may not import an app. */
const ArDiffSchema = z.object({
  stat: z.object({ files: z.number().int().nonnegative(), insertions: z.number().int().nonnegative(), deletions: z.number().int().nonnegative() }),
  patch: z.string(),
  truncated: z.boolean(),
});

const IDENTITY = ["-c", "user.name=autoresearch fixture", "-c", "user.email=fixture@example.invalid"];
const git = (cwd: string, ...args: string[]) => execGit([...IDENTITY, ...args], cwd);

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

/** A clone with the idea's fork point and one commit on top: an edit, a large new file and a binary file. */
async function ideaClone() {
  const clone = mkdtempSync(join(tmpdir(), "ar-diff-"));
  roots.push(clone);
  await git(clone, "init", "--quiet", "-b", "main");
  mkdirSync(join(clone, "src"));
  writeFileSync(join(clone, "src/gates.py"), "def accept(task):\n    return True\n");
  await git(clone, "add", ".");
  await git(clone, "commit", "--quiet", "-m", "base");
  const base = await git(clone, "rev-parse", "HEAD");
  writeFileSync(join(clone, "src/gates.py"), "def accept(task):\n    return task.ok\n");
  writeFileSync(join(clone, "src/table.py"), Array.from({ length: 20_000 }, (_, index) => `ROW_${index} = ${index}\n`).join(""));
  writeFileSync(join(clone, "src/blob.bin"), Buffer.from([0, 1, 2, 0, 255, 0]));
  await git(clone, "add", ".");
  await git(clone, "commit", "--quiet", "-m", "idea");
  return { clone, base, head: await git(clone, "rev-parse", "HEAD") };
}

const IDEA_ID = "i-0123456789ab";
const result = (stepId: string, fields: Partial<StepResult>): StepResult => ({ stepId, iteration: 0, agentId: null, signal: null, completedAt: "2026-10-21T00:00:00.000Z", ...fields });
const dispatched = (stepId: string, value: unknown) => ({ [`${stepId}:0`]: result(stepId, { operation: "dispatch", data: { result: value } }) });
const seeded = (stepId: string, value: unknown) => ({ [stepId]: result(stepId, { operation: "seed", data: {}, output: JSON.stringify(value) }) });

function pinned(pin: string) {
  const metric = { primary: { name: "score", direction: "min" }, noise: {} };
  const target = TargetSchema.parse({ schema: "ar-target/v1", ratchetPrefix: "autoresearch/fixture", metric, phases: [{ id: "p1", train: ["train-1"], stop: { ideasEvaluated: 4, roundsWithoutGain: 2 } }] });
  return { pin, ratchetRef: "refs/heads/autoresearch/fixture/run-1", ratchetHead: pin, integrationTree: "/trees/integration", target, bounds: BoundsSchema.parse({ schema: "ar-bounds/v1", classes: {} }) };
}

/** A run whose one idea stopped at L2 after building `head` on `base`. */
function recordedRun(base: string, head: string, params: Record<string, string> = { target: "fixture" }): WorkflowRun {
  const idea = {
    id: IDEA_ID, lineage: IDEA_ID, cell: "accept-gate:tighten", round: 1, hypothesis: "h", mechanism: "tighten", class: "accept-gate", direction: "tighten",
    targets: ["src/gates.py"], expectedEffect: { metric: "score", direction: "down", microSignal: "accepts" }, testPlan: "t", bold: true,
  };
  const against = { case: "train-1", head: base, bandWidth: 1, sigma: 0.25, pairs: 0, locked: false };
  const stop = { ideaId: IDEA_ID, lineage: IDEA_ID, cell: idea.cell, verdict: "rejected", reason: "clearly-worse", rungReached: "L2", head, against, runs: [] };
  const stepResults = {
    ...dispatched("ar-pin", pinned(base)),
    ...seeded("ar-queue:1", { queue: [idea], rejected: [] }),
    ...seeded("ar-select:1", { picks: [idea], draws: [], plannerTopK: [] }),
    ...dispatched(`ar-implement:1/${IDEA_ID}`, { agent: "implementer-1", mode: "spawn", head, usd: 0 }),
    ...seeded(`ar-stop:1/${IDEA_ID}`, stop),
  };
  const fields = { revision: 1, ownerGeneration: 0, currentStep: null, activeSteps: {}, startedAt: "2026-10-21T00:00:00.000Z", completedAt: null, error: null };
  return { id: "run-1", workflowName: AUTORESEARCH_WORKFLOW, params: { pin: base, ...params }, status: "running", stepResults, ...fields };
}

function contextOver(runs: readonly WorkflowRun[], clones: Record<string, string> = {}) {
  const runtime = { status: (runId: string) => runs.find((run) => run.id === runId), list: () => [...runs] };
  const autoresearchClone = vi.fn((target: string) => clones[target]);
  const ctx: FactoryContext = { warnings: [], format: "json", host: partialFake<FactoryHost>({ runtime: partialFake<FactoryHost["runtime"]>(runtime) }), autoresearchClone };
  return { ctx, autoresearchClone };
}

const command = (name: string) => AR_READ_COMMANDS.find((candidate) => candidate.name === name)!;
const call = (name: string, args: object, ctx: FactoryContext) => invokeCommand(command(name), args, ctx);

describe("autoresearch.diff", () => {
  it("answers numstat totals and a capped patch from the target's clone", async () => {
    const { clone, base, head } = await ideaClone();
    const { ctx } = contextOver([recordedRun(base, head)], { fixture: clone });
    const numstat = (await git(clone, "diff", "--numstat", base, head)).split("\n").map((line) => line.split("\t"));
    const total = (column: number) => numstat.reduce((sum, row) => sum + (row[column] === "-" ? 0 : Number(row[column])), 0);

    const { envelope } = await call("autoresearch.diff", { runId: "run-1", ideaId: IDEA_ID }, ctx);
    const small = await ideaDiff(clone, base, head, 1024);

    expect(envelope.ok).toBe(true);
    const diff = ArDiffSchema.parse(envelope.ok && envelope.data);
    expect(diff.stat).toEqual({ files: 3, insertions: total(0), deletions: total(1) });
    expect(diff.truncated).toBe(true);
    expect(small.truncated).toBe(true);
    expect(Buffer.byteLength(small.patch)).toBeLessThanOrEqual(1024);
  });

  it("refuses an idea the run never built without reading any clone", async () => {
    const { ctx, autoresearchClone } = contextOver([recordedRun("a".repeat(40), "b".repeat(40))], { fixture: "/nonexistent" });

    const { envelope } = await call("autoresearch.diff", { runId: "run-1", ideaId: "i-ffffffffffff" }, ctx);

    expect(envelope).toMatchObject({ ok: false, code: EXIT.NOINPUT, error: expect.stringContaining("[not_found]") });
    expect(autoresearchClone).not.toHaveBeenCalled();
  });

  it("refuses a target with no configured clone", async () => {
    const { ctx } = contextOver([recordedRun("a".repeat(40), "b".repeat(40))]);

    const { envelope } = await call("autoresearch.diff", { runId: "run-1", ideaId: IDEA_ID }, ctx);

    expect(envelope).toMatchObject({ ok: false, code: EXIT.CONFIG, error: expect.stringContaining("[no-config]") });
  });

  it("refuses a base or a head that is not a full hex sha before git runs", async () => {
    await expect(ideaDiff("/nonexistent", "--output=/tmp/x", "b".repeat(40))).rejects.toThrow("[diff-sha]");
    await expect(ideaDiff("/nonexistent", "a".repeat(40), "--output=/tmp/x")).rejects.toThrow("[diff-sha]");
  });
});

describe("autoresearch.runs and autoresearch.run", () => {
  it("lists only autoresearch runs and reads one by id", async () => {
    const run = recordedRun("a".repeat(40), "b".repeat(40));
    const other = { ...run, id: "land-1", workflowName: "land-pr" };
    const look = { ...run, id: "look-1", workflowName: AUTORESEARCH_VALIDATE_WORKFLOW, params: { parent: "run-1" }, stepResults: {} };
    const { ctx } = contextOver([run, other, look]);

    const listed = await call("autoresearch.runs", {}, ctx);
    const one = await call("autoresearch.run", { runId: "run-1" }, ctx);

    expect(listed.envelope.ok && listed.envelope.data).toEqual([expect.objectContaining({ runId: "run-1", target: "fixture", phase: "p1", round: 0 })]);
    expect(one.envelope.ok && one.envelope.data).toMatchObject({ runId: "run-1", rounds: [{ round: 1, ladders: [{ idea: { id: IDEA_ID, lineageDepth: 0 } }] }] });
  });

  it("shows only the looks whose parent is the run read", async () => {
    const run = recordedRun("a".repeat(40), "b".repeat(40));
    const lookOf = (id: string, parent: string, sha: string) => {
      const aggregate = { look: 1, at: "2026-10-21T00:00:00.000Z", sha, aggregate: { metrics: { score: 1 }, gates: {} }, provenance: "fixture validator", usd: 0 };
      return { ...run, id, workflowName: AUTORESEARCH_VALIDATE_WORKFLOW, params: { parent }, stepResults: dispatched("ar-validate:1", aggregate) };
    };
    const { ctx } = contextOver([run, lookOf("look-own", "run-1", "c".repeat(40)), lookOf("look-other", "run-2", "d".repeat(40))]);

    const { envelope } = await call("autoresearch.run", { runId: "run-1" }, ctx);

    expect(envelope.ok && envelope.data).toMatchObject({ validator: { looks: [{ sha: "c".repeat(40) }] } });
    const shown = z.object({ validator: z.object({ looks: z.array(z.unknown()) }) }).parse(envelope.ok && envelope.data);
    expect(shown.validator.looks).toHaveLength(1);
  });

  it("answers not_found for a run of another workflow", async () => {
    const run = { ...recordedRun("a".repeat(40), "b".repeat(40)), workflowName: "land-pr" };
    const { ctx } = contextOver([run]);

    const { envelope } = await call("autoresearch.run", { runId: "run-1" }, ctx);

    expect(envelope).toMatchObject({ ok: false, code: EXIT.NOINPUT, error: expect.stringContaining("[not_found]") });
  });
});

const UNFINISHED: WorkflowStatus[] = ["running", "paused", "cancelling", "recovery_required"];
const SEED_RUN = { schema: "ar-result/v2", case: "train-1", repeat: "b", metrics: { score: 2 }, gates: {}, violations: {}, usd: 0, wall_s: 1 };

/** A run past its baseline, so it has a best head a look can start at. */
function baselinedRun(id: string, status: WorkflowStatus = "running"): WorkflowRun {
  const run = recordedRun("a".repeat(40), "b".repeat(40));
  const baseline = Object.assign({}, ...Array.from({ length: 6 }, (_, index) => dispatched(`ar-eval:base:b${index + 1}`, SEED_RUN)));
  return { ...run, id, status, stepResults: { ...run.stepResults, ...baseline } };
}

const lookRun = (id: string, parent: string, status: WorkflowStatus): WorkflowRun => ({ ...baselinedRun(id, status), workflowName: AUTORESEARCH_VALIDATE_WORKFLOW, params: { parent }, stepResults: {} });

/** A runtime whose `start` records the run as running, and whose bare `list()` is the unfinished runs, as the real one's is. */
function writeContext(initial: readonly WorkflowRun[], inboxRoot = "/nonexistent") {
  const runs = [...initial];
  const start = vi.fn((workflowName: string, params: Record<string, string>) => {
    const id = `started-${runs.length + 1}`;
    runs.push({ ...baselinedRun(id), workflowName, params, stepResults: {} });
    return id;
  });
  const runtime = { status: (runId: string) => runs.find((run) => run.id === runId), list: (statuses = UNFINISHED) => runs.filter((run) => statuses.includes(run.status)), start };
  const autoresearch = arConfigFixture(inboxRoot, { fixture: { clone: `${inboxRoot}/fixture` }, other: { clone: `${inboxRoot}/other` } });
  const ctx: FactoryContext = { warnings: [], format: "json", host: partialFake<FactoryHost>({ runtime: partialFake<FactoryHost["runtime"]>(runtime) }), autoresearch };
  return { ctx, start };
}

const write = (name: string) => AR_WRITE_COMMANDS.find((candidate) => candidate.name === name)!;
const callWrite = async (name: string, args: object, ctx: FactoryContext) => (await invokeCommand(write(name), args, ctx)).envelope;
const PIN = "c".repeat(40);

describe("autoresearch.start", () => {
  it("refuses a target that already has an unfinished run and starts none", async () => {
    const { ctx, start } = writeContext([baselinedRun("run-1")]);

    const envelope = await callWrite("autoresearch.start", { target: "fixture", pin: PIN }, ctx);

    expect(envelope).toMatchObject({ ok: false, error: "[target-busy] run-1" });
    expect(start).not.toHaveBeenCalled();
  });

  it("starts another target with the config's run settings and the flags over them", async () => {
    const { ctx, start } = writeContext([baselinedRun("run-1")]);

    const envelope = await callWrite("autoresearch.start", { target: "other", pin: PIN, config: { lanes: 2 } }, ctx);

    expect(envelope).toMatchObject({ ok: true, data: { runId: "started-2" } });
    const [workflowName, params] = start.mock.calls[0]!;
    expect(workflowName).toBe(AUTORESEARCH_WORKFLOW);
    expect(params).toMatchObject({ target: "other", pin: PIN });
    expect(JSON.parse(params.config!)).toMatchObject({ lanes: 2, rounds: 50, forkSchedule: { basinEvery: 3 } });
  });

  it("is not blocked by an unfinished run of another workflow that names the same target", async () => {
    const { ctx, start } = writeContext([{ ...baselinedRun("land-1"), workflowName: "land-pr" }]);

    expect(await callWrite("autoresearch.start", { target: "fixture", pin: PIN }, ctx)).toMatchObject({ ok: true });
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("starts a target whose last run has finished", async () => {
    const { ctx, start } = writeContext([baselinedRun("run-1", "completed")]);

    expect(await callWrite("autoresearch.start", { target: "fixture", pin: PIN }, ctx)).toMatchObject({ ok: true });
    expect(start).toHaveBeenCalledTimes(1);
  });
});

describe("autoresearch.milestone", () => {
  it("starts two looks at the best head and refuses the third", async () => {
    const { ctx, start } = writeContext([baselinedRun("run-1")]);

    const first = await callWrite("autoresearch.milestone", { runId: "run-1" }, ctx);
    const second = await callWrite("autoresearch.milestone", { runId: "run-1" }, ctx);
    const third = await callWrite("autoresearch.milestone", { runId: "run-1" }, ctx);

    expect(first).toMatchObject({ ok: true, data: { look: 1, head: "a".repeat(40) } });
    expect(second).toMatchObject({ ok: true, data: { look: 2 } });
    expect(third).toMatchObject({ ok: false, error: "[max-looks] 2/2" });
    expect(start.mock.calls.map(([name, params]) => [name, params.parent, params.look, params.target])).toEqual([
      [AUTORESEARCH_VALIDATE_WORKFLOW, "run-1", "1", "fixture"],
      [AUTORESEARCH_VALIDATE_WORKFLOW, "run-1", "2", "fixture"],
    ]);
  });

  it("counts a failed look against the cap", async () => {
    const { ctx, start } = writeContext([baselinedRun("run-1"), lookRun("look-1", "run-1", "failed"), lookRun("look-2", "run-1", "completed")]);

    expect(await callWrite("autoresearch.milestone", { runId: "run-1" }, ctx)).toMatchObject({ ok: false, error: "[max-looks] 2/2" });
    expect(start).not.toHaveBeenCalled();
  });
});

describe("autoresearch.add-idea", () => {
  const proposal = {
    hypothesis: "h", mechanism: "tighten", class: "accept-gate", direction: "tighten", targets: ["src/gates.py"],
    expectedEffect: { metric: "score", direction: "down", microSignal: "accepts" }, testPlan: "t", bold: false,
  };

  it("refuses a run that has completed and writes nothing", async () => {
    const root = mkdtempSync(join(tmpdir(), "ar-inbox-"));
    roots.push(root);
    const { ctx } = writeContext([baselinedRun("run-1", "completed")], root);

    const envelope = await callWrite("autoresearch.add-idea", { runId: "run-1", proposal }, ctx);

    expect(envelope).toMatchObject({ ok: false, error: "[run-finished] run-1 is completed" });
    expect(existsSync(join(root, "inbox"))).toBe(false);
  });

  it("appends a running run's idea to its inbox, where the port reads it once", async () => {
    const root = mkdtempSync(join(tmpdir(), "ar-inbox-"));
    roots.push(root);
    const { ctx } = writeContext([baselinedRun("run-1")], root);

    expect(await callWrite("autoresearch.add-idea", { runId: "run-1", proposal }, ctx)).toMatchObject({ ok: true });
    const read = ownerIdeasPort(join(root, "inbox"));
    const signal = new AbortController().signal;

    expect(await read({ runId: "run-1", round: 2, after: 0 }, signal)).toMatchObject({ ideas: [{ hypothesis: "h" }], cursor: 1 });
    expect(await read({ runId: "run-1", round: 3, after: 1 }, signal)).toEqual({ ideas: [], cursor: 1 });
  });
});
