import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { JudgeConfigSchema } from "../eval-harness.js";
import { fakeRewriter } from "../rewrite-fixtures.test-helpers.js";
import { BridgeFileSchema, type BridgeFile } from "./bridge.js";
import { sha256 } from "./artifacts.js";
import { newRuntime, openState, resumeVideo, runOneStage, runVideo, writeReport } from "./host.js";
import { compareReports } from "./report.js";
import { runStageCached } from "./stage-cache.js";
import { stageKey, stageSpec, type RunSettings } from "./stage-spec.js";
import { canonicalJson } from "../eval-store.js";
import { stylePack } from "../profile-fixtures.test-helpers.js";
import type { StylePack } from "../style-pack-schema.js";
import { fakeBridge, fakeHost, fakeScriptModel, fixture, spokenOf, type Fixture } from "./run-fakes.test-helpers.js";

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
    expect(statuses(second)).toEqual({ gather: "not run", audition: "not run", script: "cached", rewrite: "cached", eval: "cached", resolve: "cached", tts: "cached", render: "ran", qa: "ran", sheets: "ran", export: "ran" });
    expect(bridge.calls).toEqual(["render.ts", "qa.ts", "sheets.sh", "variety.mjs"]);
    expect(model.prompts).toHaveLength(1);
    expect(second.report.totals.usd).toBe(0);
    expect(row(second, "render").outputs.mp4).not.toBe(row(first, "render").outputs.mp4);
  });

  it("a new style pack reruns render and what reads it, never tts", async () => {
    fx = fixture();
    const model = fakeScriptModel();
    const bridge = fakeBridge();
    await runVideo({ spine: fx.spine, facts: fx.facts, variants: { render: variantFile("render", "drafting", { stylePack: "night-drafting" }) } }, fakeHost(fx, model, bridge));
    bridge.calls.length = 0;

    const second = await runVideo({ spine: fx.spine, facts: fx.facts, variants: { render: variantFile("render", "paper", { stylePack: "paper-margin" }) } }, fakeHost(fx, model, bridge));

    expect(second.status, second.error).toBe("completed");
    expect(statuses(second)).toMatchObject({ script: "cached", tts: "cached", render: "ran" });
    // The fake render writes the same MP4 for any pack, so QA and sheets, keyed on its sha, hit the cache.
    expect(bridge.calls).toEqual(["render.ts"]);
  });

  it("a stage's wall time spans its body, read from the clock after the body returns", async () => {
    fx = fixture();
    const bridge = fakeBridge();
    let clock = Date.parse("2026-10-22T00:00:00Z");
    const exec: typeof bridge.exec = async (req) => {
      if (req.argv[1]!.endsWith("render.ts")) clock += 42_000;
      return bridge.exec(req);
    };

    const result = await runVideo({ spine: fx.spine, facts: fx.facts }, fakeHost(fx, fakeScriptModel(), bridge, { exec, now: () => new Date(clock) }));

    expect(row(result, "render").wallMs).toBe(42_000);
    expect(row(result, "qa").wallMs).toBe(0);
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
    expect(statuses(second)).toEqual({ gather: "not run", audition: "not run", script: "cached", rewrite: "ran", eval: "ran", resolve: "ran", tts: "ran", render: "ran", qa: "ran", sheets: "ran", export: "ran" });
    expect(unchanged.prompts.length).toBeGreaterThan(0);
    expect(bridge.calls).toEqual(["render.ts", "qa.ts", "sheets.sh", "variety.mjs"]);
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

describe("pins over a base run", () => {
  it("a pin replaces the base run's output for the stages after --from", async () => {
    fx = fixture();
    const bridge = fakeBridge();
    const first = await runVideo({ spine: fx.spine, facts: fx.facts }, fakeHost(fx, fakeScriptModel(), bridge));
    const draft = row(first, "script").outputs.draft!;

    const repair = await runVideo({ from: "eval", base: first.runId, pins: { script: draft } }, fakeHost(fx, fakeScriptModel(), bridge));

    expect(repair.status, repair.error).toBe("completed");
    expect(row(repair, "eval").status).toBe("ran");
    expect(spokenOf(fx, row(repair, "tts").outputs.words!)).toBe(spokenOf(fx, draft));
  });

  it("a run based on a pinned run keeps the pin, not the output the pinned run only reused", async () => {
    fx = fixture();
    const bridge = fakeBridge();
    const first = await runVideo({ spine: fx.spine, facts: fx.facts }, fakeHost(fx, fakeScriptModel(), bridge));
    const draft = row(first, "script").outputs.draft!;
    const repair = await runVideo({ from: "eval", base: first.runId, pins: { script: draft } }, fakeHost(fx, fakeScriptModel(), bridge));

    const followUp = await runVideo({ from: "tts", base: repair.runId }, fakeHost(fx, fakeScriptModel(), bridge));

    expect(followUp.status, followUp.error).toBe("completed");
    expect(row(repair, "tts").outputs).not.toEqual(row(first, "tts").outputs);
    expect(row(followUp, "tts").outputs).toEqual(row(repair, "tts").outputs);
  });

  it("a resumed pinned run keeps the pin for the runs based on it", async () => {
    fx = fixture();
    const bridge = fakeBridge();
    const first = await runVideo({ spine: fx.spine, facts: fx.facts }, fakeHost(fx, fakeScriptModel(), bridge));
    const draft = row(first, "script").outputs.draft!;
    const failed = await runVideo({ from: "eval", base: first.runId, pins: { script: draft } }, fakeHost(fx, fakeScriptModel(), fakeBridge({ qaFails: true })));
    const resumed = await resumeVideo(failed.runId, fakeHost(fx, fakeScriptModel(), bridge));

    const followUp = await runVideo({ from: "tts", base: resumed.runId }, fakeHost(fx, fakeScriptModel(), bridge));

    expect(failed.status).toBe("failed");
    expect(resumed.status, resumed.error).toBe("completed");
    expect(row(failed, "tts").outputs).not.toEqual(row(first, "tts").outputs);
    expect(row(followUp, "tts").outputs).toEqual(row(failed, "tts").outputs);
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

    expect(rows.filter((r) => r.status[1] === "cached").map((r) => r.stage)).toEqual(["script", "rewrite", "eval", "resolve", "tts"]);
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

  it("a render key changes with any edit to the style pack's file under the same variant file", () => {
    const variant = { sha: "b".repeat(64), value: { schema: "explainer.variant/v1" as const, stage: "render" as const, name: "plain", params: { stylePack: "plain" } } };
    const keyWith = (pack: StylePack) => keyOf({ variant, stylePacks: () => new Map([["plain", pack]]) });
    const base = keyWith(stylePack("plain"));

    expect(keyWith({ ...stylePack("plain"), tokens: { ...stylePack("plain").tokens, lift: "lift-4" } })).not.toBe(base);
    expect(keyWith({ ...stylePack("plain"), feel: "A reworded feel." })).not.toBe(base);
  });

  it("hands the bridge the pack's id, theme and CSS as vars", () => {
    const variant = { sha: "b".repeat(64), value: { schema: "explainer.variant/v1" as const, stage: "render" as const, name: "plain", params: { stylePack: "plain", workers: 8 } } };
    const spec = stageSpec({ stage: "render", artifacts: { words: "a".repeat(64) }, settings: SETTINGS, sample: 0, remainingUsd: 1, bridge: () => BRIDGE("4"), variant, stylePacks: () => new Map([["plain", stylePack("plain")]]) });

    expect(spec.config.vars).toMatchObject({ workers: "8", stylePack: "plain", styleTheme: "dark" });
    expect(spec.config.vars?.styleCss).toContain("--pack-accent: var(--color-brand-primary);");
  });

  it("refuses a style pack on any stage but render, and a pack with no file", () => {
    const tts = { schema: "explainer.variant/v1" as const, stage: "tts" as const, name: "styled", params: { stylePack: "night-drafting" } };
    const loud = { sha: "b".repeat(64), value: { schema: "explainer.variant/v1" as const, stage: "render" as const, name: "loud", params: { stylePack: "loud" } } };

    expect(() => stageSpec({ stage: "tts", artifacts: { script: "a".repeat(64), resolved: "d".repeat(64) }, settings: SETTINGS, sample: 0, remainingUsd: 1, bridge: () => BRIDGE("4"), variant: { sha: "c".repeat(64), value: tts } })).toThrow(/only a render variant/);
    expect(() => keyOf({ variant: loud })).toThrow(/unknown style pack loud/);
  });

  it("an eval key changes with the judge, since eval scores the cold-viewer rows with it", () => {
    const evalKey = (model: string) => stageSpec({
      stage: "eval", artifacts: { script: "a".repeat(64), spine: "c".repeat(64) }, settings: { ...SETTINGS, judge: { ...SETTINGS.judge, model } },
      sample: 0, remainingUsd: 1, bridge: () => BRIDGE("4"),
    }).key;

    expect(evalKey("haiku")).not.toBe(evalKey("sonnet"));
  });

  // A gather cached under g1 has no coverage output, and reading it would turn the coverage gate into a pass.
  it("a gather key never matches one cached before the gather made a coverage manifest", () => {
    const spec = { stage: "gather" as const, config: {}, inputs: {}, sample: 0 };
    const beforeCoverage = sha256(canonicalJson({ ...spec, version: "g1" }));

    expect(stageKey(spec)).not.toBe(beforeCoverage);
  });
});


/** Rewrites a run's plan as an X1 run stored it, with no video id. */
function dropVideoId(runId: string): void {
  const db = openState(fx.dataDir);
  const raw = z.object({ params: z.string() }).parse(db.prepare("SELECT params FROM workflow_run WHERE id = ?").get(runId));
  const params = z.object({ plan: z.string() }).parse(JSON.parse(raw.params));
  const plan = z.record(z.string(), z.unknown()).parse(JSON.parse(params.plan));
  delete plan.videoId;
  db.prepare("UPDATE workflow_run SET params = ? WHERE id = ?").run(JSON.stringify({ plan: JSON.stringify(plan) }), runId);
  db.close();
}
