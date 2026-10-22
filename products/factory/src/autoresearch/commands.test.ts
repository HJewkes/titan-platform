import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUTORESEARCH_VALIDATE_WORKFLOW, AUTORESEARCH_WORKFLOW, BoundsSchema, TargetSchema } from "@titan-design/autoresearch";
import { EXIT, invokeCommand } from "@titan-design/registry";
import type { StepResult, WorkflowRun } from "@titan-design/workflow";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { FactoryHost } from "../host.js";
import type { FactoryContext } from "../registry.js";
import { AR_READ_COMMANDS } from "./commands.js";
import { ideaDiff } from "./diff-read.js";
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
  const ctx: FactoryContext = { warnings: [], format: "json", host: { runtime } as unknown as FactoryHost, autoresearchClone };
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

  it("refuses a sha that is not a full hex sha before git runs", async () => {
    await expect(ideaDiff("/nonexistent", "--output=/tmp/x", "b".repeat(40))).rejects.toThrow("[diff-sha]");
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

  it("answers not_found for a run of another workflow", async () => {
    const run = { ...recordedRun("a".repeat(40), "b".repeat(40)), workflowName: "land-pr" };
    const { ctx } = contextOver([run]);

    const { envelope } = await call("autoresearch.run", { runId: "run-1" }, ctx);

    expect(envelope).toMatchObject({ ok: false, code: EXIT.NOINPUT, error: expect.stringContaining("[not_found]") });
  });
});
