import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { ArtifactStore, sha256 } from "../workflow/artifacts.js";
import { openState, runOneStage, runVideo } from "../workflow/host.js";
import { fakeHost, fakeRender, fakeScriptModel, fixture, type Fixture } from "../workflow/run-fakes.test-helpers.js";
import { runStageChecks } from "../workflow/stage-checks.js";
import { SYNTHETIC_ANCHORS, SYNTHETIC_LAYER, writeSyntheticTree } from "./custom-layer-fixture.test-helpers.js";
import type { FakeRenderOptions } from "./render-fakes.test-helpers.js";
import { FAKE_HOST } from "./render-fixtures.test-helpers.js";
import { RenderManifestSchema, type RenderManifest } from "./render-manifest.js";

let fx: Fixture;
afterEach(() => fx.cleanup());

const TreeSchema = z.object({ entries: z.array(z.object({ path: z.string(), sha: z.string() })) });
const TimelineIdsSchema = z.object({ beats: z.array(z.object({ id: z.string() })) });

const artifact = (sha: string): string => readFileSync(path.join(fx.dataDir, "artifacts", sha), "utf8");

/** The file at `rel` in a stored tree, or undefined when the tree has none. */
function treeFile(treeSha: string, rel: string): string | undefined {
  const entry = TreeSchema.parse(JSON.parse(artifact(treeSha))).entries.find((e) => e.path === rel);
  return entry === undefined ? undefined : artifact(entry.sha);
}

/** A fake run to tts, whose outputs pin the render stage's inputs. */
async function voiced(): Promise<Record<string, string>> {
  const first = await runVideo({ spine: fx.spine, facts: fx.facts, to: "tts" }, fakeHost(fx, fakeScriptModel(), fakeRender()));
  const out = (stage: string) => first.report.rows.find((row) => row.stage === stage)!.outputs;
  return { script: out("rewrite").script!, resolved: out("resolve").resolved!, words: out("tts").words!, audio: out("tts").audio! };
}

/** The render stage alone on the voiced inputs, with the variant params given; each engine option is its own variant, so no call reads another's cache entry. */
async function renderStage(params: Record<string, unknown> = {}, options: FakeRenderOptions = {}) {
  const inputs = await voiced();
  const variant = path.join(fx.dataDir, "render.variant.json");
  writeFileSync(variant, JSON.stringify({ schema: "explainer.variant/v1", stage: "render", name: `fake ${JSON.stringify(options)}`, params }));
  const render = fakeRender(options);
  const record = await runOneStage({ stage: "render", inputs, variant }, fakeHost(fx, fakeScriptModel(), render));
  return { inputs, record, render, manifest: RenderManifestSchema.parse(JSON.parse(artifact(record.outputs["render-manifest"]!))) };
}

const ResolvedRowsSchema = z.looseObject({ beats: z.array(z.looseObject({ id: z.string(), layer: z.string() })) });
const CustomBeatSchema = z.object({ beats: z.array(z.looseObject({ id: z.string(), layer: z.string().optional(), module: z.string().optional(), anchors: z.array(z.string()).optional() })) });

/** The voiced inputs with the first resolved beat turned custom, and a custom-layers tree holding `modules` for it. */
async function customInputs(modules?: Record<string, string>): Promise<Record<string, string>> {
  const inputs = await voiced();
  const resolved = ResolvedRowsSchema.parse(JSON.parse(artifact(inputs.resolved!)));
  const first = resolved.beats[0]!;
  const from = { runId: "input", stage: "input" };
  const db = openState(fx.dataDir);
  try {
    const store = new ArtifactStore(fx.dataDir, db);
    const custom = { ...resolved, beats: [{ ...first, layer: "custom" }, ...resolved.beats.slice(1)] };
    const tree = writeSyntheticTree(mkdtempSync(path.join(fx.dataDir, "tree-")), first.id, modules);
    return { ...inputs, resolved: store.putText(JSON.stringify(custom), "resolved", from), "custom-layers": store.putTree(tree, "custom-layers", from) };
  } finally {
    db.close();
  }
}

describe("the render stage's custom layers", () => {
  // Mutation: render's inputs leave out custom-layers, or render-stage never bundles the tree into the page.
  it("bundles a custom beat's layer into the served page and names it from the timeline beat", async () => {
    fx = fixture();
    const inputs = await customInputs();

    const record = await runOneStage({ stage: "render", inputs }, fakeHost(fx, fakeScriptModel(), fakeRender()));

    const beat = CustomBeatSchema.parse(JSON.parse(artifact(record.outputs.timeline!))).beats[0]!;
    expect(beat).toMatchObject({ id: "beat-01", layer: "custom", module: "./custom-layers/beat-01.js", anchors: SYNTHETIC_ANCHORS });
    const bundled = treeFile(record.outputs.page!, "custom-layers/beat-01.js");
    expect(bundled).toContain("Parcels waiting");
    expect(bundled).not.toMatch(/from\s*["']react["']/);
  });

  it("fails naming the beat when the run has no custom-layers tree", async () => {
    fx = fixture();
    const inputs = Object.fromEntries(Object.entries(await customInputs()).filter(([name]) => name !== "custom-layers"));

    const render = runOneStage({ stage: "render", inputs }, fakeHost(fx, fakeScriptModel(), fakeRender()));

    await expect(render).rejects.toThrow(/custom layer for beat "h1" is not built/);
  });

  it("rejects naming the module when the tree lacks the file its index names", async () => {
    fx = fixture();
    const inputs = await customInputs({ "other.tsx": SYNTHETIC_LAYER });

    const render = runOneStage({ stage: "render", inputs }, fakeHost(fx, fakeScriptModel(), fakeRender()));

    await expect(render).rejects.toThrow(/custom layer for beat "[^"]+": module "[^"]+\.tsx" is missing from the custom-layers tree/);
  });
});

describe("the render stage", () => {
  it("draws the board under beat-NN ids, and renames the voiced words.json beats to match", async () => {
    fx = fixture();

    const { inputs, record, render } = await renderStage();

    const scriptIds = TimelineIdsSchema.parse(JSON.parse(artifact(inputs.words!))).beats.map((beat) => beat.id);
    const expected = scriptIds.map((_, i) => `beat-${String(i + 1).padStart(2, "0")}`);
    expect(TimelineIdsSchema.parse(JSON.parse(artifact(record.outputs.timeline!))).beats.map((beat) => beat.id)).toEqual(expected);
    expect(render.renders[0]!.audio!.words.beats.map((beat) => beat.id)).toEqual(expected);
  });

  it("stores the page tree it served, so qa serves the same page", async () => {
    fx = fixture();

    const { record, render } = await renderStage();

    expect(render.renders[0]!.pageSha).toBe(sha256(`${TreeSchema.parse(JSON.parse(artifact(record.outputs.page!))).entries.map((e) => `${e.sha}  ${e.path}`).join("\n")}\n`));
    expect(treeFile(record.outputs.page!, "index.html")).toContain("fake composition");
  });

  it("serves a style pack's CSS from the page head, and no stylesheet without a pack", async () => {
    fx = fixture();
    const styled = await renderStage({ stylePack: "paper-margin" });
    const plain = await renderStage();

    expect(treeFile(styled.record.outputs.page!, "style-pack.css")).toMatch(/^:root \{ --pack-/);
    expect(treeFile(styled.record.outputs.page!, "index.html")).toContain('<link rel="stylesheet" href="./style-pack.css" /></head>');
    expect(treeFile(plain.record.outputs.page!, "style-pack.css")).toBeUndefined();
    expect(treeFile(plain.record.outputs.page!, "index.html")).not.toContain("style-pack.css");
  });

  it("gates on the qa profile by default, and records qaGate skipped under noQa", async () => {
    fx = fixture();
    const gated = await renderStage();
    const skipped = await renderStage({ noQa: true });

    expect(gated.manifest.qaGate).toBe("passed");
    expect(skipped.manifest.qaGate).toBe("skipped");
    expect(skipped.render.renders[0]!.qa?.mode).toBe("skip");
  });

  it("refuses to render while the page holds QA errors", async () => {
    fx = fixture();

    const render = renderStage({}, { qa: { findingsAt: () => [{ kind: "text-overlap", el: "h2", text: "a", other: "b", at: { x: 0, y: 0, w: 9, h: 9 } }] } });

    await expect(render).rejects.toThrow(/qa: refusing to render render: \d+ held errors/);
  });

  it("reports two-run as a failed, non-gating check when the second render's bytes differ", async () => {
    fx = fixture();
    const same = await renderStage({ twoRun: true });
    const differs = await renderStage({ twoRun: true }, { varies: true });

    expect(same.render.renders).toHaveLength(2);
    expect(same.record.checks.find((c) => c.name === "two-run")).toMatchObject({ gate: false, pass: true });
    expect(differs.record.checks.find((c) => c.name === "two-run")).toMatchObject({ gate: false, pass: false });
    expect(differs.record.checks.find((c) => c.name === "duration-agreement")).toMatchObject({ gate: true, pass: true });
  });

  it("renders once and reports no two-run check unless the variant asks", async () => {
    fx = fixture();

    const { record, render } = await renderStage();

    expect(render.renders).toHaveLength(1);
    expect(record.checks.map((c) => c.name)).toEqual(["duration-agreement"]);
  });
});

/** A manifest that parses, with the page and mix lengths given. */
function manifest(pageDurationS: number, durationS: number): RenderManifest {
  const sha = "a".repeat(64);
  return {
    schema: "explainer.render-manifest/v1", workers: 2, fps: 30, frames: 60, durationS, pageDurationS, renderWallS: 1, draft: false, qaGate: "skipped",
    host: FAKE_HOST, shas: { timeline: sha, page: sha, mix: sha, mp4: sha, vtt: sha },
  };
}

function durationCheck(stored: RenderManifest) {
  const text = JSON.stringify(stored);
  const store = { readText: (sha: string) => (sha === sha256(text) ? text : "") };
  return runStageChecks("render", { artifacts: { "render-manifest": sha256(text) }, store, l0Checks: [] }).checks;
}

describe("the render stage's duration-agreement gate", () => {
  it("fails a stage whose manifest has the page outlasting the mix", () => {
    const checks = durationCheck(manifest(10.5, 10));

    expect(checks).toEqual([{ name: "duration-agreement", gate: true, pass: false, detail: "page lasts 10.5 s but the audio mix 10 s" }]);
  });

  it("passes a manifest whose lengths agree within the tolerance", () => {
    const checks = durationCheck(manifest(10 + 5e-7, 10));

    expect(checks).toMatchObject([{ name: "duration-agreement", gate: true, pass: true }]);
  });
});
