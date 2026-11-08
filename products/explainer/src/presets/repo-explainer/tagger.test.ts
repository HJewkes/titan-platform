import { SqliteGateStore, gateMigration, gateResolverMigration } from "@titan-design/hitl/sqlite";
import { openDatabase, runMigrations, type Db } from "@titan-design/store-sqlite";
import {
  idempotentRunner,
  inlineRunner,
  workflowMigration,
  workflowOwnershipMigration,
  WorkflowRuntime,
  type StepRunInput,
  type StepRunner,
} from "@titan-design/workflow";
import { describe, expect, it, vi } from "vitest";
import type { ExplainerFact } from "./schemas.js";
import { tagFacts, type TagControl, type TaggerArm, type TagFactsOptions, type TagFactsResult, type TagRole } from "./tagger.js";

const fact = (id: string, text = `The ${id} module stores runs in sqlite.`): ExplainerFact => ({
  id, source: "topic", kind: "feature", text, evidence: [{ path: `src/${id}.ts`, lineStart: 1, lineEnd: 3 }],
  tier: "core", verified: "yes", license_safe: true,
});

const FACTS = Array.from({ length: 5 }, (_, i) => fact(`F-${i + 1}`));
const CONTROLS: TagControl[] = [
  { fact: fact("C-1", "The CLI entry point is bin.ts."), expect: "entry" },
  { fact: fact("C-2", "The retry loop backs off exponentially."), expect: "algorithm" },
];
const CONTROL_IDS = new Set(CONTROLS.map((control) => control.fact.id));
const EXPECTED = new Map(CONTROLS.map((control) => [control.fact.id, control.expect]));

const baseOptions = (arm: TaggerArm = "haiku"): TagFactsOptions => ({
  arm, controls: CONTROLS, onePager: "A synthetic job runner.", viewer: "a senior engineer new to this repo", batchSize: 2, concurrency: 1,
  excerpt: (span) => `// ${span.path} lines ${span.lineStart}-${span.lineEnd}`,
});

const shownIds = (prompt: string): string[] => [...prompt.matchAll(/^### (\S+)$/gm)].map((match) => match[1]!);

/** A fake model: tags each shown fact `mechanism`, and each control with `controlRole`, by default the expected one. */
function fakeModel(controlRole: (input: StepRunInput, id: string) => TagRole = (_, id) => EXPECTED.get(id)!) {
  return (input: StepRunInput): string => {
    const tags = shownIds(input.prompt).map((id) => ({
      id, role: [CONTROL_IDS.has(id) ? controlRole(input, id) : "mechanism"], novelty: 1, visual: 2, visual_kind: "code", idea_line: `${id} in one line`,
    }));
    return JSON.stringify({ tags });
  };
}

function makeDb(): Db {
  const db = openDatabase(":memory:");
  runMigrations(db, [gateMigration(1), workflowMigration(2), workflowOwnershipMigration(3), gateResolverMigration(4)]);
  return db;
}

const runtime = (db: Db, runner: StepRunner) => new WorkflowRuntime({ db, gates: new SqliteGateStore(db, { migrate: false }), runner, gatePollMs: 10 });

function register(rt: WorkflowRuntime, options: TagFactsOptions, sink: TagFactsResult[]): void {
  rt.register("tag", async (ctx) => {
    sink.push(await tagFacts(ctx, FACTS, options));
  });
}

async function runTagger(runner: StepRunner, options = baseOptions()): Promise<TagFactsResult> {
  const rt = runtime(makeDb(), runner);
  const sink: TagFactsResult[] = [];
  register(rt, options, sink);
  expect(await rt.wait(rt.start("tag"))).toMatchObject({ status: "completed" });
  return sink[0]!;
}

describe("tagFacts", () => {
  it.each(["haiku", "sonnet"] as const)("plants one control in every batch and calls the %s arm's model", async (arm) => {
    const inputs: StepRunInput[] = [];
    const model = fakeModel();

    const out = await runTagger(inlineRunner((input) => (inputs.push(input), model(input))), baseOptions(arm));

    expect(inputs.map((input) => input.model)).toEqual([arm, arm, arm]);
    for (const input of inputs) expect(shownIds(input.prompt).filter((id) => CONTROL_IDS.has(id))).toHaveLength(1);
    expect(inputs.every((input) => input.stepId.startsWith(`tag:${arm}/`))).toBe(true);
    expect(out.tags.map((tag) => tag.id)).toEqual(FACTS.map((f) => f.id));
    expect(out.dropped).toEqual([]);
  });

  it("shows the viewer, the one-pager and each evidence excerpt in the prompt", async () => {
    const prompts: string[] = [];
    const model = fakeModel();

    await runTagger(inlineRunner((input) => (prompts.push(input.prompt), model(input))));

    expect(prompts[0]).toContain("The viewer: a senior engineer new to this repo.");
    expect(prompts[0]).toContain("A synthetic job runner.");
    expect(prompts[0]).toContain("// src/F-1.ts lines 1-3");
  });

  it("re-runs a batch once when it fails its control and keeps the retry's tags", async () => {
    const stepIds: string[] = [];
    const model = fakeModel((input) => (input.stepId.endsWith(":retry") ? EXPECTED.get(shownIds(input.prompt).find((id) => CONTROL_IDS.has(id))!)! : "ux"));

    const out = await runTagger(inlineRunner((input) => (stepIds.push(input.stepId), model(input))));

    expect(stepIds.filter((id) => id.endsWith(":retry"))).toHaveLength(3);
    expect(out.tags.map((tag) => tag.id)).toEqual(FACTS.map((f) => f.id));
    expect(out.dropped).toEqual([]);
  });

  it("drops a batch that fails its control twice and still tags the other batches", async () => {
    let calls = 0;
    const model = fakeModel((_, id) => (calls === 1 || calls === 2 ? "ux" : EXPECTED.get(id)!));

    const out = await runTagger(inlineRunner((input) => (calls++, model(input))));

    expect(out.dropped).toEqual([{ key: expect.any(String), factIds: ["F-1", "F-2"], error: expect.stringMatching(/^control C-\d expected role \w+, got ux on both attempts$/) }]);
    expect(out.tags.map((tag) => tag.id)).toEqual(["F-3", "F-4", "F-5"]);
    expect(out.stoppedBy).toBeNull();
  });

  it("drops a batch whose reply leaves the control untagged", async () => {
    const reply = JSON.stringify({ tags: [{ id: "F-1", role: ["value"], novelty: 0, visual: 0, visual_kind: "card", idea_line: "one" }] });

    const out = await runTagger(inlineRunner(() => reply), { ...baseOptions(), batchSize: 5 });

    expect(out.dropped).toEqual([{ key: expect.any(String), factIds: FACTS.map((f) => f.id), error: expect.stringMatching(/^control C-\d was not tagged on both attempts$/) }]);
    expect(out.tags).toEqual([]);
  });

  it("resumes a crashed run by batch, calling the model only for batches that had not finished", async () => {
    const db = makeDb();
    let firstCalls = 0;
    const model = fakeModel();
    const first = runtime(db, idempotentRunner(inlineRunner((input) => (++firstCalls === 2 ? new Promise<string>(() => undefined) : model(input)))));
    register(first, baseOptions(), []);
    const runId = first.start("tag");
    await vi.waitFor(() => expect(Object.keys(first.status(runId)?.activeSteps ?? {})).toHaveLength(1));
    first.shutdown();

    const resumed: string[] = [];
    const second = runtime(db, idempotentRunner(inlineRunner((input) => (resumed.push(input.stepId), model(input)))));
    const sink: TagFactsResult[] = [];
    register(second, baseOptions(), sink);
    await second.hydrate();
    expect(await second.wait(runId)).toMatchObject({ status: "completed" });

    expect(resumed).toHaveLength(2);
    expect(sink[0]!.tags.map((tag) => tag.id)).toEqual(FACTS.map((f) => f.id));
  });

  it("refuses to tag with an empty control pool", async () => {
    const rt = runtime(makeDb(), inlineRunner(fakeModel()));
    register(rt, { ...baseOptions(), controls: [] }, []);

    expect(await rt.wait(rt.start("tag"))).toMatchObject({ status: "failed", error: expect.stringContaining("control pool is empty") });
  });
});
