import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BeatWorker, BuilderRef, LayerBuild } from "../build/beat-worker.js";
import type { LayerCheckInput, LayerTextCheck } from "../build/layer-text.js";
import { FontLoadError } from "@titan-design/frame-capture";
import { ArtifactStore } from "./artifacts.js";
import { openState, runOneStage } from "./host.js";
import { CUSTOM_LAYERS, UNBUILT_LAYERS } from "./layer-build.js";
import { customBeatInputs } from "./layer-repair.test-helpers.js";
import { runPaths, readJson } from "./run-dir.js";
import { StageRecordSchema } from "./records.js";
import { fakeRender, fakeHost, fakeScriptModel, fixture, type Fixture } from "./run-fakes.test-helpers.js";

// Synthetic: an invented parcel desk; no real script, layer or session.
let fx: Fixture;
afterEach(() => fx.cleanup());

const BUILDER: BuilderRef = { id: "claude-print", version: "1", model: "fake-model", basePromptSha: "a".repeat(64) };
const NAN_LAYER = "export default () => <span id=\"parcels\">{NaN} parcels held</span>;\n";
const OWN_FONT_LAYER = "export default () => <span id=\"parcels\" style={{ fontFamily: \"Inter\" }}>12 parcels held</span>;\n";
const GOOD_LAYER = "export default () => <span id=\"parcels\">12 parcels held</span>;\n";

/** A fake model that answers its packets with `modules` in turn, keeping each packet it was sent. */
function scriptedWorker(...modules: string[]) {
  const packets: string[] = [];
  const worker: BeatWorker = {
    builder: BUILDER,
    build: async ({ packet, json }): Promise<LayerBuild> => {
      packets.push(json);
      const module = modules[Math.min(packets.length, modules.length) - 1]!;
      return { module, anchors: packet.anchors, elements: [], usage: { usd: 0.01, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, calls: 1 } };
    },
  };
  return { packets, worker };
}

/** Stands in for the rendered check: a layer whose source draws `{NaN}` shows "NaN" in its parcels span. */
function nanCheck() {
  const checked: LayerCheckInput[] = [];
  const check: LayerTextCheck = async (input) => {
    checked.push(input);
    return input.layer.build.module.includes("{NaN}")
      ? [{ beat: input.layer.beatId, element: "span#parcels", rule: "bad-text", text: "NaN parcels held", atS: 1.5 }] : [];
  };
  return { checked, check };
}

const AMBER_LAYER = "export default () => <div style={{ background: \"#f5a524\" }}><span id=\"parcels\" style={{ color: \"#ffffff\" }}>12</span></div>;\n";
const ON_ACCENT_LAYER = "export default () => <div style={{ background: \"var(--color-brand-primary-solid)\" }}><span id=\"parcels\" style={{ color: \"var(--color-on-brand-primary)\" }}>12</span></div>;\n";

/** Stands in for the rendered check: white on the amber fill measures 2.04:1, as qa's low-contrast rule reports it. */
const amberCheck: LayerTextCheck = async ({ layer }) =>
  layer.build.module.includes("#f5a524")
    ? [{ beat: layer.beatId, element: "span#parcels", rule: "low-contrast", text: "12", atS: 1, contrast: { ratio: 2.04, need: 3, colour: "#ffffff", ground: "#f5a524" } }]
    : [];

const FADED_BADGE_LAYER = "export default () => <div id=\"parcels\"><span id=\"badge\" style={{ opacity: ramp(t, 1.2) }}>fixed</span></div>;\n";
const SLID_BADGE_LAYER = "export default () => <div id=\"parcels\"><span id=\"badge\" style={{ transform: `translateY(${(1 - p) * 30}px)` }}>fixed</span></div>;\n";
const FADED_SHAPE_LAYER = "export default () => <div id=\"parcels\"><div id=\"bar\" style={{ opacity: ramp(t, 1.2) }} /><span>12</span></div>;\n";

const hostWith = (worker: BeatWorker, layerTextCheck: LayerTextCheck) =>
  fakeHost(fx, fakeScriptModel(), fakeRender(), { beatWorker: worker, layerTextCheck });

describe("the text check on custom-layer builds", () => {
  it("rebuilds once a layer that draws NaN, naming the element and rule, and stores the rebuild", async () => {
    // Arrange
    fx = fixture();
    const { packets, worker } = scriptedWorker(NAN_LAYER, GOOD_LAYER);
    const { checked, check } = nanCheck();

    // Act
    const record = await runOneStage({ stage: "resolve", inputs: customBeatInputs(fx.dataDir) }, hostWith(worker, check));

    // Assert
    expect(packets).toHaveLength(2);
    expect(JSON.parse(packets[1]!).rebuild).toMatch(/^the last build broke qa's text rules: bad-text on span#parcels "NaN parcels held" \(draw a real value/);
    expect(checked).toHaveLength(2);
    const tree = path.join(runPaths(fx.dataDir, record.childRunId!).runDir, CUSTOM_LAYERS);
    expect(readFileSync(path.join(tree, "b1.tsx"), "utf8")).toBe(GOOD_LAYER);
    expect(record.usage).toMatchObject({ usd: 0.02, calls: 2 });
  });

  it("fails resolve with a row naming the beat, element and rule when the rebuild still draws NaN", async () => {
    // Arrange
    fx = fixture();
    const { packets, worker } = scriptedWorker(NAN_LAYER);

    // Act
    const run = runOneStage({ stage: "resolve", inputs: customBeatInputs(fx.dataDir) }, hostWith(worker, nanCheck().check));

    // Assert
    await expect(run).rejects.toThrow(
      'custom layers not built: b1 (needs repair: the layer breaks qa\'s text rules after one rebuild: b1 span#parcels bad-text "NaN parcels held" at 1.50 s)',
    );
    expect(packets).toHaveLength(2);
  });

  it("stores a layer that passes the check with one model call and no rebuild", async () => {
    // Arrange
    fx = fixture();
    const { packets, worker } = scriptedWorker(GOOD_LAYER);
    const { checked, check } = nanCheck();

    // Act
    const record = await runOneStage({ stage: "resolve", inputs: customBeatInputs(fx.dataDir) }, hostWith(worker, check));

    // Assert
    expect(packets).toHaveLength(1);
    expect(JSON.parse(packets[0]!).rebuild).toBeUndefined();
    expect(checked.map((input) => input.packet.beat_id)).toEqual(["b1"]);
    expect(record.outputs[CUSTOM_LAYERS]).toBeDefined();
  });

  // Mutations: a check that cannot run is rebuilt as a defect (the model is called twice), or its reason loses the URL.
  it("fails resolve as an infra error naming the face and URL when fonts cannot load, with no model rebuild", async () => {
    // Arrange
    fx = fixture();
    const { packets, worker } = scriptedWorker(GOOD_LAYER);
    const unloaded: LayerTextCheck = async () => {
      throw new FontLoadError([{ family: "Inter", status: "error" }], ["http://127.0.0.1:1/page/assets/latin-x.woff2"]);
    };

    // Act
    const run = runOneStage({ stage: "resolve", inputs: customBeatInputs(fx.dataDir) }, hostWith(worker, unloaded));

    // Assert
    await expect(run).rejects.toThrow(
      "custom layers not built: b1 (layer check could not run, not a layer defect: fonts not loaded: Inter (error); font requests that failed: http://127.0.0.1:1/page/assets/latin-x.woff2)",
    );
    expect(packets).toHaveLength(1);
  });

  // Mutation: the unbuilt branch of the tree step stores no layer sources.
  it.each([
    ["the check cannot run", async () => { throw new Error("browser did not start"); }, GOOD_LAYER],
    ["the rebuild still breaks a rule", undefined, NAN_LAYER],
  ])("keeps the built layer sources in the failed record when %s", async (_case, check, layer) => {
    // Arrange
    fx = fixture();
    const { worker } = scriptedWorker(layer);

    // Act
    await runOneStage({ stage: "resolve", inputs: customBeatInputs(fx.dataDir) }, hostWith(worker, check ?? nanCheck().check)).catch(() => undefined);

    // Assert
    const runId = readdirSync(path.join(fx.dataDir, "runs")).find((id) => readJson(runPaths(fx.dataDir, id).failed("resolve"), StageRecordSchema));
    const failed = readJson(runPaths(fx.dataDir, runId!).failed("resolve"), StageRecordSchema)!;
    const db = openState(fx.dataDir);
    const dest = path.join(fx.dataDir, "unbuilt-copy");
    new ArtifactStore(fx.dataDir, db).materialise(failed.outputs[UNBUILT_LAYERS]!, dest);
    db.close();
    expect(readFileSync(path.join(dest, "b1.tsx"), "utf8")).toBe(layer);
  });

  // Mutations: the font check never runs, or its rebuild is skipped, or its hint drops the line.
  it("rebuilds once a layer that names its own font, naming the line and the theme font tokens", async () => {
    // Arrange
    fx = fixture();
    const { packets, worker } = scriptedWorker(OWN_FONT_LAYER, GOOD_LAYER);

    // Act
    const record = await runOneStage({ stage: "resolve", inputs: customBeatInputs(fx.dataDir) }, hostWith(worker, nanCheck().check));

    // Assert
    expect(packets).toHaveLength(2);
    expect(JSON.parse(packets[1]!).rebuild).toMatch(/^the last build set its own fonts: line 1 \(font family\).*--font-family-body/);
    const tree = path.join(runPaths(fx.dataDir, record.childRunId!).runDir, CUSTOM_LAYERS);
    expect(readFileSync(path.join(tree, "b1.tsx"), "utf8")).toBe(GOOD_LAYER);
  });

  it("fails resolve when the rebuild still names its own font", async () => {
    // Arrange
    fx = fixture();
    const { packets, worker } = scriptedWorker(OWN_FONT_LAYER);

    // Act
    const run = runOneStage({ stage: "resolve", inputs: customBeatInputs(fx.dataDir) }, hostWith(worker, nanCheck().check));

    // Assert
    await expect(run).rejects.toThrow("custom layers not built: b1 (needs repair: the layer still sets its own fonts after one rebuild: line 1 (font family))");
    expect(packets).toHaveLength(2);
  });

  it("builds a layer with no font of its own in one model call", async () => {
    // Arrange
    fx = fixture();
    const { packets, worker } = scriptedWorker(GOOD_LAYER);

    // Act
    await runOneStage({ stage: "resolve", inputs: customBeatInputs(fx.dataDir) }, hostWith(worker, nanCheck().check));

    // Assert
    expect(packets).toHaveLength(1);
  });

  it("a layer drawing white text on an amber bar under 3:1 gets one rebuild naming the text and its ratio", async () => {
    // Arrange
    fx = fixture();
    const { packets, worker } = scriptedWorker(AMBER_LAYER, ON_ACCENT_LAYER);

    // Act
    const record = await runOneStage({ stage: "resolve", inputs: customBeatInputs(fx.dataDir) }, hostWith(worker, amberCheck));

    // Assert
    expect(packets).toHaveLength(2);
    expect(JSON.parse(packets[1]!).rebuild).toMatch(/^the last build broke qa's text rules: low-contrast on span#parcels "12" \(#ffffff on #f5a524 is 2\.04:1, under the 3:1 .*--color-on-brand-primary/);
    const tree = path.join(runPaths(fx.dataDir, record.childRunId!).runDir, CUSTOM_LAYERS);
    expect(readFileSync(path.join(tree, "b1.tsx"), "utf8")).toBe(ON_ACCENT_LAYER);
  });

  it("a layer whose text passes contrast is not rebuilt", async () => {
    // Arrange
    fx = fixture();
    const { packets, worker } = scriptedWorker(ON_ACCENT_LAYER);

    // Act
    await runOneStage({ stage: "resolve", inputs: customBeatInputs(fx.dataDir) }, hostWith(worker, amberCheck));

    // Assert
    expect(packets).toHaveLength(1);
  });

  // Mutations: the opacity check never runs, or its hint drops the element or the text.
  it("a layer that fades a text badge in by opacity gets one rebuild naming the badge", async () => {
    // Arrange
    fx = fixture();
    const { packets, worker } = scriptedWorker(FADED_BADGE_LAYER, SLID_BADGE_LAYER);

    // Act
    const record = await runOneStage({ stage: "resolve", inputs: customBeatInputs(fx.dataDir) }, hostWith(worker, nanCheck().check));

    // Assert
    expect(packets).toHaveLength(2);
    expect(JSON.parse(packets[1]!).rebuild).toContain('b1 badge "fixed": enter text at full colour, by translate, scale or clip-path, never an opacity fade');
    const tree = path.join(runPaths(fx.dataDir, record.childRunId!).runDir, CUSTOM_LAYERS);
    expect(readFileSync(path.join(tree, "b1.tsx"), "utf8")).toBe(SLID_BADGE_LAYER);
  });

  it("a layer that fades a non-text shape is not flagged", async () => {
    // Arrange
    fx = fixture();
    const { packets, worker } = scriptedWorker(FADED_SHAPE_LAYER);

    // Act
    await runOneStage({ stage: "resolve", inputs: customBeatInputs(fx.dataDir) }, hostWith(worker, nanCheck().check));

    // Assert
    expect(packets).toHaveLength(1);
  });

  it("the opacity finding joins the other findings in the same single rebuild", async () => {
    // Arrange
    fx = fixture();
    const both = FADED_BADGE_LAYER.replace("{ opacity", "{ background: \"#f5a524\", color: \"#ffffff\", opacity");
    const contrastRow: LayerTextCheck = async ({ layer }) =>
      layer.build.module.includes("#f5a524")
        ? [{ beat: layer.beatId, element: "span#badge", rule: "low-contrast", text: "fixed", atS: 1.5, contrast: { ratio: 2.04, need: 3, colour: "#ffffff", ground: "#f5a524" } }]
        : [];
    const { packets, worker } = scriptedWorker(both, SLID_BADGE_LAYER);

    // Act
    await runOneStage({ stage: "resolve", inputs: customBeatInputs(fx.dataDir) }, hostWith(worker, contrastRow));

    // Assert
    expect(packets).toHaveLength(2);
    const rebuild: string = JSON.parse(packets[1]!).rebuild;
    expect(rebuild).toContain("low-contrast on span#badge");
    expect(rebuild).toContain("it is mid-fade, so enter text at full colour");
    expect(rebuild).toContain('b1 badge "fixed": enter text at full colour');
  });

  it("fails resolve when the rebuild still fades its text", async () => {
    // Arrange
    fx = fixture();
    const { packets, worker } = scriptedWorker(FADED_BADGE_LAYER);

    // Act
    const run = runOneStage({ stage: "resolve", inputs: customBeatInputs(fx.dataDir) }, hostWith(worker, nanCheck().check));

    // Assert
    await expect(run).rejects.toThrow('after one rebuild: b1 badge fades text "fixed" by opacity');
    expect(packets).toHaveLength(2);
  });
});
