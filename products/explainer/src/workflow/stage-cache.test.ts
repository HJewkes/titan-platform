import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JudgeConfigSchema } from "../eval-harness.js";
import { fakeRewriter } from "../rewrite-fixtures.test-helpers.js";
import { BridgeFileSchema, type BridgeFile } from "./bridge.js";
import { sha256 } from "./artifacts.js";
import { newRuntime, openState, runOneStage, runVideo, writeReport } from "./host.js";
import { compareReports } from "./report.js";
import { runStageCached } from "./stage-cache.js";
import { stageSpec, type RunSettings } from "./stage-spec.js";
import { fakeBridge, fakeHost, fakeScriptModel, fixture, type Fixture } from "./run-fakes.test-helpers.js";

let fx: Fixture;
afterEach(() => fx.cleanup());

const row = (outcome: Awaited<ReturnType<typeof runVideo>>, stage: string) => outcome.report.rows.find((r) => r.stage === stage)!;
const statuses = (outcome: Awaited<ReturnType<typeof runVideo>>) => Object.fromEntries(outcome.report.rows.map((r) => [r.stage, r.status]));

function variantFile(stage: string, name: string, params: Record<string, unknown>): string {
  const file = path.join(fx.dataDir, `${stage}-${name}.variant.json`);
  writeFileSync(file, JSON.stringify({ schema: "explainer.variant/v1", stage, name, params }));
  return file;
}

describe("stage cache over whole runs", () => {
  it("same script, new render variant: only render, qa and sheets run again", async () => {
    fx = fixture();
    const model = fakeScriptModel();
    const bridge = fakeBridge();
    const first = await runVideo({ spine: fx.spine, facts: fx.facts }, fakeHost(fx, model, bridge));
    bridge.calls.length = 0;

    const second = await runVideo({ spine: fx.spine, facts: fx.facts, variants: { render: variantFile("render", "w8", { workers: 8 }) } }, fakeHost(fx, model, bridge));

    expect(second.status, second.error).toBe("completed");
    expect(statuses(second)).toEqual({ script: "cached", rewrite: "cached", eval: "cached", tts: "cached", render: "ran", qa: "ran", sheets: "ran", export: "ran" });
    expect(bridge.calls).toEqual(["render.ts", "qa.ts", "sheets.sh"]);
    expect(model.prompts).toHaveLength(1);
    expect(second.report.totals.usd).toBe(0);
    expect(row(second, "render").outputs.mp4).not.toBe(row(first, "render").outputs.mp4);
  });

  it("a new rewrite variant runs rewrite and every stage whose input it changed", async () => {
    fx = fixture();
    const model = fakeScriptModel();
    const bridge = fakeBridge();
    const champion = fakeRewriter();
    const unchanged = fakeRewriter(() => undefined);
    const harnessFor = (config: { model: string }) => (config.model === "haiku" ? unchanged.harness : champion.harness);
    await runVideo({ spine: fx.spine, facts: fx.facts }, fakeHost(fx, model, bridge, { harnessFor }));
    bridge.calls.length = 0;

    const second = await runVideo({ spine: fx.spine, facts: fx.facts, variants: { rewrite: variantFile("rewrite", "haiku", { model: "haiku" }) } }, fakeHost(fx, model, bridge, { harnessFor }));

    expect(second.status, second.error).toBe("completed");
    expect(statuses(second)).toEqual({ script: "cached", rewrite: "ran", eval: "ran", tts: "ran", render: "ran", qa: "ran", sheets: "ran", export: "ran" });
    expect(unchanged.prompts.length).toBeGreaterThan(0);
    expect(bridge.calls).toEqual(["tts.mjs", "render.ts", "qa.ts", "sheets.sh"]);
  });

  it("a variant file for another stage is refused before any stage runs", async () => {
    fx = fixture();

    await expect(runVideo({ spine: fx.spine, facts: fx.facts, variants: { render: variantFile("qa", "x", {}) } }, fakeHost(fx, fakeScriptModel(), fakeBridge())))
      .rejects.toThrow(/is for stage qa, not render/);
  });

  it("--to stops after the named stage, so the run never reaches the theater", async () => {
    fx = fixture();
    const bridge = fakeBridge();

    const result = await runVideo({ spine: fx.spine, facts: fx.facts, to: "rewrite" }, fakeHost(fx, fakeScriptModel(), bridge));

    expect(result.status, result.error).toBe("completed");
    expect(statuses(result)).toMatchObject({ script: "ran", rewrite: "ran", eval: "not run", export: "not run" });
    expect(bridge.calls).toEqual([]);
  });

  it("--from with pins and no base starts mid-pipeline, and a missing input fails naming it", async () => {
    fx = fixture();
    const bridge = fakeBridge();
    const first = await runVideo({ spine: fx.spine, facts: fx.facts }, fakeHost(fx, fakeScriptModel(), bridge));
    const { words, audio } = row(first, "tts").outputs;

    const pinned = await runVideo({ from: "render", pins: { words: words!, audio: audio! }, variants: { render: variantFile("render", "w2", { workers: 2 }) } }, fakeHost(fx, fakeScriptModel(), bridge));
    const missing = await runVideo({ from: "render", pins: { words: words! } }, fakeHost(fx, fakeScriptModel(), bridge));

    expect(pinned.status, pinned.error).toBe("completed");
    expect(statuses(pinned)).toMatchObject({ tts: "not run", render: "ran", export: "ran" });
    expect(missing.status).toBe("failed");
    expect(missing.error).toContain('stage render needs artifact "audio"');
  });
});

describe("explainer stage", () => {
  it("two samples are two cached runs, and a repeated sample is a cache hit", async () => {
    fx = fixture();
    const model = fakeScriptModel();
    const host = fakeHost(fx, model, fakeBridge());
    await runVideo({ spine: fx.spine, facts: fx.facts, to: "script" }, host);
    const inputs = { spine: sha256(readFileSync(fx.spine)), facts: sha256(readFileSync(fx.facts)) };
    model.prompts.length = 0;

    const one = await runOneStage({ stage: "script", inputs, sample: 1 }, host);
    const two = await runOneStage({ stage: "script", inputs, sample: 2 }, host);
    const again = await runOneStage({ stage: "script", inputs, sample: 1 }, host);

    expect(model.prompts).toHaveLength(2);
    expect(one.childRunId).not.toBe(two.childRunId);
    expect(one.key).not.toBe(two.key);
    expect(again).toMatchObject({ cached: true, key: one.key, childRunId: one.childRunId, outputs: one.outputs });
  });
});

/** A rewrite harness that holds every call until `release`, so a test can act while the child is live. */
function heldRewriter() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const inner = fakeRewriter();
  const harness: typeof inner.harness = async (call) => {
    await gate;
    return inner.harness(call);
  };
  return { harnessFor: () => harness, release };
}

describe("adopt or start", () => {
  async function rewriteSpec() {
    const host = fakeHost(fx, fakeScriptModel(), fakeBridge());
    const first = await runVideo({ spine: fx.spine, facts: fx.facts, to: "script" }, host);
    return (rt: ReturnType<typeof newRuntime>) => stageSpec({ stage: "rewrite", artifacts: row(first, "script").outputs, settings: SETTINGS, sample: 5, remainingUsd: 1, bridge: rt.bridge });
  }
  const children = (rt: ReturnType<typeof newRuntime>) => rt.runtime.list(["running", "completed", "failed"]).filter((run) => run.workflowName === "explainer.rewrite");

  it("a second caller with the same key waits on the live child instead of starting another", async () => {
    fx = fixture();
    const specFor = await rewriteSpec();
    const held = heldRewriter();
    const db = openState(fx.dataDir);
    const rt = newRuntime(db, fakeHost(fx, fakeScriptModel(), fakeBridge(), { harnessFor: held.harnessFor }));
    const spec = specFor(rt);

    const a = runStageCached(rt.cache, spec);
    const b = runStageCached(rt.cache, spec);
    held.release();
    const [ra, rb] = await Promise.all([a, b]);
    const made = children(rt);
    db.close();

    expect(rb.childRunId).toBe(ra.childRunId);
    expect(rb.cached).toBeUndefined();
    expect(made).toHaveLength(1);
  });

  it("after a crash, the next caller claims the orphaned child and finishes it", async () => {
    fx = fixture();
    const specFor = await rewriteSpec();
    const held = heldRewriter();
    const db1 = openState(fx.dataDir);
    const crashed = newRuntime(db1, fakeHost(fx, fakeScriptModel(), fakeBridge(), { harnessFor: held.harnessFor }));
    const orphan = runStageCached(crashed.cache, specFor(crashed)).catch((error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 20));
    crashed.runtime.shutdown();
    const db2 = openState(fx.dataDir);
    const next = newRuntime(db2, fakeHost(fx, fakeScriptModel(), fakeBridge()));

    const record = await runStageCached(next.cache, specFor(next));
    held.release();
    await orphan;
    const made = children(next).map((run) => [run.id, run.status]);
    db1.close();
    db2.close();

    expect(record.stage).toBe("rewrite");
    expect(made).toEqual([[record.childRunId, "completed"]]);
  });
});

describe("linked runs of one video", () => {
  it("a repair run from stored artifacts joins the video, and each run's report sums them", async () => {
    fx = fixture();
    const model = fakeScriptModel(undefined, { usd: 0.25 });
    const bridge = fakeBridge();
    const first = await runVideo({ spine: fx.spine, facts: fx.facts }, fakeHost(fx, model, bridge));

    const repair = await runVideo({ from: "render", base: first.runId, variants: { render: variantFile("render", "w8", { workers: 8 }) } }, fakeHost(fx, model, bridge));
    const firstAgain = writeReport(first.runId, { dataDir: fx.dataDir }).report;

    expect(repair.report.videoId).toBe(first.runId);
    expect(repair.report.linked).toEqual([{ runId: first.runId, usd: first.report.totals.usd }]);
    expect(firstAgain.linked).toEqual([{ runId: repair.runId, usd: repair.report.totals.usd }]);
    expect(firstAgain.videoUsd).toBeCloseTo(first.report.totals.usd + repair.report.totals.usd);
    expect(repair.report.videoUsd).toBeCloseTo(firstAgain.videoUsd);
  });

  it("a run whose plan predates video ids belongs to the video at the root of its base chain", async () => {
    fx = fixture();
    const model = fakeScriptModel();
    const bridge = fakeBridge();
    const first = await runVideo({ spine: fx.spine, facts: fx.facts }, fakeHost(fx, model, bridge));
    const middle = await runVideo({ from: "sheets", base: first.runId }, fakeHost(fx, model, bridge));
    dropVideoId(middle.runId);

    const last = await runVideo({ from: "sheets", base: middle.runId }, fakeHost(fx, model, bridge));

    expect(last.report.videoId).toBe(first.runId);
    expect(last.report.linked.map((r) => r.runId)).toEqual([first.runId, middle.runId]);
  });

  it("a new video started with no base is not linked to an earlier one", async () => {
    fx = fixture();
    const model = fakeScriptModel();
    await runVideo({ spine: fx.spine, facts: fx.facts }, fakeHost(fx, model, fakeBridge()));

    const other = await runVideo({ spine: fx.spine, facts: fx.facts }, fakeHost(fx, model, fakeBridge()));

    expect(other.report.videoId).toBe(other.runId);
    expect(other.report.linked).toEqual([]);
  });

  it("compare names the stages the second run took from the cache and the outputs that changed", async () => {
    fx = fixture();
    const model = fakeScriptModel();
    const bridge = fakeBridge();
    const first = await runVideo({ spine: fx.spine, facts: fx.facts }, fakeHost(fx, model, bridge));
    const second = await runVideo({ spine: fx.spine, facts: fx.facts, variants: { render: variantFile("render", "w8", { workers: 8 }) } }, fakeHost(fx, model, bridge));

    const rows = compareReports(first.report, second.report);

    expect(rows.filter((r) => r.status[1] === "cached").map((r) => r.stage)).toEqual(["script", "rewrite", "eval", "tts"]);
    expect(rows.find((r) => r.stage === "render")!.changed).toEqual(["mp4"]);
    expect(rows.find((r) => r.stage === "script")!.usdDelta).toBeCloseTo(-row(first, "script").usd);
  });
});

const SETTINGS: RunSettings = { scriptModel: "sonnet", judge: JudgeConfigSchema.parse({ provider: "claude-print", model: "sonnet" }), rounds: 2 };
const BRIDGE = (workers: string): BridgeFile => BridgeFileSchema.parse({
  schema: "explainer-bridge/v1", workdir: "/work", theater: { dir: "/theater", stem: "demo", files: {} },
  stages: { render: { inputs: { words: "w.json" }, outputs: {}, commands: [{ argv: ["r"] }], vars: { workers } } },
});
const keyOf = (overrides: Partial<Parameters<typeof stageSpec>[0]>) =>
  stageSpec({ stage: "render", artifacts: { words: "a".repeat(64) }, settings: SETTINGS, sample: 0, remainingUsd: 1, bridge: () => BRIDGE("4"), ...overrides }).key;

describe("stage key", () => {
  it("changes with the variant file, the sample, a read input or the bridge block, and with nothing else", () => {
    const base = keyOf({});
    const variant = { sha: "b".repeat(64), value: { schema: "explainer.variant/v1" as const, stage: "render" as const, name: "w4", params: { workers: 4 } } };

    expect(keyOf({ remainingUsd: 9 })).toBe(base);
    expect(keyOf({ artifacts: { words: "a".repeat(64), spine: "c".repeat(64) } })).toBe(base);
    expect(keyOf({ variant })).not.toBe(base);
    expect(keyOf({ sample: 1 })).not.toBe(base);
    expect(keyOf({ artifacts: { words: "d".repeat(64) } })).not.toBe(base);
    expect(keyOf({ bridge: () => BRIDGE("8") })).not.toBe(base);
  });

  it("refuses a variant param the bridge block declares no default for", () => {
    const variant = { sha: "b".repeat(64), value: { schema: "explainer.variant/v1" as const, stage: "render" as const, name: "typo", params: { wokers: 8 } } };

    expect(() => keyOf({ variant })).toThrow(/sets wokers/);
  });
});


/** Rewrites a run's plan as an X1 run stored it, with no video id. */
function dropVideoId(runId: string): void {
  const db = openState(fx.dataDir);
  const raw = db.prepare("SELECT params FROM workflow_run WHERE id = ?").get(runId) as { params: string };
  const params = JSON.parse(raw.params) as { plan: string };
  const { videoId: _dropped, ...plan } = JSON.parse(params.plan) as Record<string, unknown>;
  db.prepare("UPDATE workflow_run SET params = ? WHERE id = ?").run(JSON.stringify({ plan: JSON.stringify(plan) }), runId);
  db.close();
}
