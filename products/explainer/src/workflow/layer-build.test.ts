import { SqliteGateStore } from "@titan-design/hitl/sqlite";
import type { Db } from "@titan-design/store-sqlite";
import { routedRunner, WorkflowRuntime, type StepRoute } from "@titan-design/workflow";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BeatWorker, BuilderRef, LayerBuild } from "../build/beat-worker.js";
import { resolveScript, visual } from "../resolve-fixtures.test-helpers.js";
import { ArtifactStore } from "./artifacts.js";
import { DEFAULT_JUDGE, openState, runOneStage } from "./host.js";
import { CUSTOM_LAYERS, layerRoutes } from "./layer-build.js";
import { fakeBridge, fakeHost, fakeScriptModel, fixture, type Fixture } from "./run-fakes.test-helpers.js";
import { CHECKS_STEP, childRecord, childWorkflow } from "./stage-cache.js";
import { stageSpec } from "./stage-spec.js";
import { bodyRoute, checksRoute, stageWorkflow } from "./stage-workflows.js";

// Synthetic: an invented parcel desk; no real script, facts, prompt or session.
let fx: Fixture;
afterEach(() => fx.cleanup());

const BUILDER: BuilderRef = { id: "claude-print", version: "1", model: "fake-model", basePromptSha: "a".repeat(64) };
const CUSTOM = { visual: visual({ layer: "custom", anchors: ["B2:E5"] }), fact_ids: ["F-1"] };
const TEMPLATE = { visual: visual({ layer: "template" }), fact_ids: ["F-1"] };
const FACTS = JSON.stringify({ items: [{ id: "F-1", text: "Each scan waits for a ledger entry." }] });

/** A beat worker that counts its calls and answers every packet with a one-line layer at a fixed price. */
function countingWorker(fail: (beatId: string) => boolean = () => false, builder: BuilderRef = BUILDER) {
  const calls: string[] = [];
  const worker: BeatWorker = {
    builder,
    build: async ({ packet }): Promise<LayerBuild> => {
      calls.push(packet.beat_id);
      if (fail(packet.beat_id)) throw new Error(`fake build refused ${packet.beat_id}`);
      return { module: `export const Layer = () => "${packet.beat_id}";\n`, anchors: packet.anchors, elements: [], usage: { usd: 0.01, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, calls: 1 } };
    },
  };
  return { calls, worker };
}

function putInputs(db: Db, texts: Record<string, string>): Record<string, string> {
  const store = new ArtifactStore(fx.dataDir, db);
  return Object.fromEntries(Object.entries(texts).map(([name, text]) => [name, store.putText(text, name, { runId: "input", stage: "input" })]));
}

function inputs(beats: Parameters<typeof resolveScript>[0], extra: Record<string, string> = {}): Record<string, string> {
  const db = openState(fx.dataDir);
  try {
    return putInputs(db, { script: JSON.stringify(resolveScript(beats)), facts: FACTS, ...extra });
  } finally {
    db.close();
  }
}

const host = (worker?: BeatWorker) => fakeHost(fx, fakeScriptModel(), fakeBridge(), worker ? { beatWorker: worker } : {});

function treeFiles(sha: string): string[] {
  const db = openState(fx.dataDir);
  try {
    const tree = JSON.parse(new ArtifactStore(fx.dataDir, db).readText(sha)) as { entries: { path: string }[] };
    return tree.entries.map((entry) => entry.path);
  } finally {
    db.close();
  }
}

describe("custom-layer builds in explainer.resolve", () => {
  it("builds one layer per custom beat and stores them as a custom-layers tree", async () => {
    fx = fixture();
    const { calls, worker } = countingWorker();
    const pins = inputs([["b1", "WHAT", CUSTOM], ["b2", "WHAT", TEMPLATE], ["b3", "WHAT", CUSTOM]]);

    const record = await runOneStage({ stage: "resolve", inputs: pins }, host(worker));

    expect(calls.sort()).toEqual(["b1", "b3"]);
    expect(treeFiles(record.outputs[CUSTOM_LAYERS]!)).toEqual(["b1.tsx", "b3.tsx", "layers.json"]);
    expect(record.usage).toMatchObject({ usd: 0.02, calls: 2 });
  });

  it("runs zero items for a script with no custom beats, and stores no tree", async () => {
    fx = fixture();
    const { calls, worker } = countingWorker();

    const record = await runOneStage({ stage: "resolve", inputs: inputs([["b1", "WHAT", TEMPLATE]]) }, host(worker));

    expect(calls).toEqual([]);
    expect(record.outputs[CUSTOM_LAYERS]).toBeUndefined();
  });

  it("runs zero items when a custom-layers tree is pinned", async () => {
    fx = fixture();
    const { calls, worker } = countingWorker();
    const pins = inputs([["b1", "WHAT", CUSTOM]], { [CUSTOM_LAYERS]: "pinned layers" });

    const record = await runOneStage({ stage: "resolve", inputs: pins }, host(worker));

    expect(calls).toEqual([]);
    expect(record.notes).toContain(`${CUSTOM_LAYERS} pinned: no layer builds`);
  });

  it("leaves custom beats unbuilt with a note when no beat worker is configured", async () => {
    fx = fixture();

    const record = await runOneStage({ stage: "resolve", inputs: inputs([["b1", "WHAT", CUSTOM]]) }, host());

    expect(record.outputs[CUSTOM_LAYERS]).toBeUndefined();
    expect(record.notes).toContain("custom beats b1 left unbuilt: no beat worker is configured");
  });

  it("fails the stage naming the beat whose build failed", async () => {
    fx = fixture();
    const { worker } = countingWorker((beatId) => beatId === "b2");
    const pins = inputs([["b1", "WHAT", CUSTOM], ["b2", "WHAT", CUSTOM]]);

    const run = runOneStage({ stage: "resolve", inputs: pins }, host(worker));

    await expect(run).rejects.toThrow(/custom layers not built: b2 \(.*fake build refused b2/);
  });

  it("re-keys the resolve stage when the builder's base prompt changes, so every layer is rebuilt", async () => {
    fx = fixture();
    const pins = inputs([["b1", "WHAT", CUSTOM], ["b2", "WHAT", CUSTOM]]);
    await runOneStage({ stage: "resolve", inputs: pins }, host(countingWorker().worker));
    const edited = countingWorker(undefined, { ...BUILDER, basePromptSha: "b".repeat(64) });

    const record = await runOneStage({ stage: "resolve", inputs: pins }, host(edited.worker));

    expect(record.cached).toBeFalsy();
    expect(edited.calls.sort()).toEqual(["b1", "b2"]);
  });
});

/** The resolve child workflow on routes the test picks, so a checks step can hang where a crash would stop it. */
function resolveRuntime(db: Db, worker: BeatWorker, checks: StepRoute) {
  const store = new ArtifactStore(fx.dataDir, db);
  const bridge = () => { throw new Error("resolve runs no bridge"); };
  const body = bodyRoute({ dataDir: fx.dataDir, store, bridge, exec: async () => { throw new Error("resolve runs no bridge"); } });
  const runner = routedRunner([body, checks, ...layerRoutes({ dataDir: fx.dataDir, store, worker })]);
  const runtime = new WorkflowRuntime({ db, gates: new SqliteGateStore(db, { migrate: false }), runner, leaseMs: 60_000 });
  runtime.register(childWorkflow("resolve"), stageWorkflow(), { version: "test" });
  return { runtime, store };
}

describe("custom-layer builds across a crash", () => {
  it("replays the resolve workflow after a restart with unchanged packets and dispatches zero worker calls", async () => {
    fx = fixture();
    const pins = inputs([["b1", "WHAT", CUSTOM], ["b2", "WHAT", CUSTOM]]);
    const db = openState(fx.dataDir);
    const spec = stageSpec({ stage: "resolve", artifacts: pins, settings: { scriptModel: "m", judge: DEFAULT_JUDGE, rounds: 1 }, sample: 0, remainingUsd: 1, bridge: () => { throw new Error("no bridge"); }, builder: BUILDER });
    const hang: StepRoute = { match: CHECKS_STEP, onRestart: "repeat", runner: { run: () => new Promise(() => undefined) } };
    const before = countingWorker();
    const first = resolveRuntime(db, before.worker, hang).runtime;
    const runId = first.start(childWorkflow("resolve"), { spec: JSON.stringify(spec) });
    await vi.waitFor(() => expect(first.status(runId)?.activeSteps[`${CHECKS_STEP}:resolve`]).toBeDefined());
    first.shutdown();
    const after = countingWorker();
    const { runtime: second } = resolveRuntime(db, after.worker, checksRoute({ dataDir: fx.dataDir, store: new ArtifactStore(fx.dataDir, db), evalChecks: [] }));

    expect(await second.hydrate()).toEqual([runId]);
    const finished = await second.wait(runId);
    db.close();

    expect(finished.status, finished.error ?? undefined).toBe("completed");
    expect(before.calls.sort()).toEqual(["b1", "b2"]);
    expect(after.calls).toEqual([]);
    expect(childRecord(finished)?.outputs[CUSTOM_LAYERS]).toBeDefined();
  });
});
