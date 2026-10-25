import { rmSync } from "node:fs";
import path from "node:path";
import { SqliteGateStore } from "@titan-design/hitl/sqlite";
import type { Db } from "@titan-design/store-sqlite";
import { routedRunner, WorkflowRuntime, type StepRoute } from "@titan-design/workflow";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { BeatWorker, BuilderRef, LayerBuild } from "../build/beat-worker.js";
import { resolveScript, visual } from "../resolve-fixtures.test-helpers.js";
import { ArtifactStore } from "./artifacts.js";
import { DEFAULT_JUDGE, openState, runOneStage } from "./host.js";
import { CUSTOM_LAYERS, LAYER_BUILDS_DIR, layerRoutes } from "./layer-build.js";
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
const TreeSchema = z.object({ entries: z.array(z.object({ path: z.string() })) });
const FACTS = JSON.stringify({ items: [{ id: "F-1", text: "Each scan waits for a ledger entry." }] });

/** A beat worker that counts its calls and answers every packet with a one-line layer (or `module`'s) at a fixed price. */
function countingWorker(fail: (beatId: string) => boolean = () => false, builder: BuilderRef = BUILDER, module?: (beatId: string) => string) {
  const calls: string[] = [];
  const worker: BeatWorker = {
    builder,
    build: async ({ packet }): Promise<LayerBuild> => {
      calls.push(packet.beat_id);
      if (fail(packet.beat_id)) throw new Error(`fake build refused ${packet.beat_id}`);
      const source = module?.(packet.beat_id) ?? `export const Layer = () => "${packet.beat_id}";\n`;
      return { module: source, anchors: packet.anchors, elements: [], usage: { usd: 0.01, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, calls: 1 } };
    },
  };
  return { calls, worker };
}

const customAt = (anchors: string[]) => ({ visual: visual({ layer: "custom", anchors }), fact_ids: ["F-1"] });

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
    const tree = TreeSchema.parse(JSON.parse(new ArtifactStore(fx.dataDir, db).readText(sha)));
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
    // Without the cross-run build cache, only the run's own item memo can spare the second worker.
    rmSync(path.join(fx.dataDir, LAYER_BUILDS_DIR), { recursive: true, force: true });
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

describe("custom-layer builds across runs", () => {
  it("reuses every build whose packet is unchanged when a script edit makes a new resolve run", async () => {
    fx = fixture();
    await runOneStage({ stage: "resolve", inputs: inputs([["b1", "WHAT", CUSTOM], ["b2", "WHAT", TEMPLATE]]) }, host(countingWorker().worker));
    const second = countingWorker();
    const edited = inputs([["b1", "WHAT", CUSTOM], ["b2", "WHAT", { ...TEMPLATE, visual: visual({ layer: "template", assertion: "The desk logs every refusal" }) }]]);

    const record = await runOneStage({ stage: "resolve", inputs: edited }, host(second.worker));

    expect(record.cached).toBeFalsy();
    expect(second.calls).toEqual([]);
    expect(treeFiles(record.outputs[CUSTOM_LAYERS]!)).toEqual(["b1.tsx", "layers.json"]);
    expect(record.notes).toContain("1 custom layers built (1 from the build cache)");
    expect(record.usage).toMatchObject({ usd: 0, calls: 0 });
  });

  it("calls the worker once, for the one beat whose packet changed", async () => {
    fx = fixture();
    await runOneStage({ stage: "resolve", inputs: inputs([["b1", "WHAT", CUSTOM], ["b2", "WHAT", CUSTOM]]) }, host(countingWorker().worker));
    const second = countingWorker();

    await runOneStage({ stage: "resolve", inputs: inputs([["b1", "WHAT", CUSTOM], ["b2", "WHAT", customAt(["C3"])]]) }, host(second.worker));

    expect(second.calls).toEqual(["b2"]);
  });
});

describe("the compile gate on custom-layer builds", () => {
  it("marks a build that does not compile as needing repair, with esbuild's error, and never caches it", async () => {
    fx = fixture();
    const pins = inputs([["b1", "WHAT", CUSTOM]]);
    const broken = () => "export default function Layer() {\n  return <div>;\n}\n";
    const first = countingWorker(undefined, BUILDER, broken);

    const run = runOneStage({ stage: "resolve", inputs: pins }, host(first.worker));

    await expect(run).rejects.toThrow(/custom layers not built: b1 \(needs repair: layer\.tsx:\d+:\d+: /);
    const retry = countingWorker(undefined, BUILDER, broken);
    await expect(runOneStage({ stage: "resolve", inputs: pins }, host(retry.worker))).rejects.toThrow(/needs repair/);
    expect(retry.calls).toEqual(["b1"]);
  });

  it("refuses a build that imports a module outside the allowlist", async () => {
    fx = fixture();
    const reader = countingWorker(undefined, BUILDER, () => `import { readFileSync } from "node:fs";\nexport const Layer = () => readFileSync("ledger");\n`);

    const run = runOneStage({ stage: "resolve", inputs: inputs([["b1", "WHAT", CUSTOM]]) }, host(reader.worker));

    await expect(run).rejects.toThrow(/b1 \(needs repair: .*import "node:fs" is not allowed in a custom layer/);
  });
});
