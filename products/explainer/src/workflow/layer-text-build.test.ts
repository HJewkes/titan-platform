import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BeatWorker, BuilderRef, LayerBuild } from "../build/beat-worker.js";
import type { LayerCheckInput, LayerTextCheck } from "../build/layer-text.js";
import { runOneStage } from "./host.js";
import { CUSTOM_LAYERS } from "./layer-build.js";
import { customBeatInputs } from "./layer-repair.test-helpers.js";
import { runPaths } from "./run-dir.js";
import { fakeRender, fakeHost, fakeScriptModel, fixture, type Fixture } from "./run-fakes.test-helpers.js";

// Synthetic: an invented parcel desk; no real script, layer or session.
let fx: Fixture;
afterEach(() => fx.cleanup());

const BUILDER: BuilderRef = { id: "claude-print", version: "1", model: "fake-model", basePromptSha: "a".repeat(64) };
const NAN_LAYER = "export default () => <span id=\"parcels\">{NaN} parcels held</span>;\n";
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
});
