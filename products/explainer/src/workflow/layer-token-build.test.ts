import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BeatWorker, BuilderRef, LayerBuild } from "../build/beat-worker.js";
import type { LayerTextCheck } from "../build/layer-text.js";
import { runOneStage } from "./host.js";
import { CUSTOM_LAYERS } from "./layer-build.js";
import { customBeatInputs } from "./layer-repair.test-helpers.js";
import { runPaths } from "./run-dir.js";
import { fakeHost, fakeRender, fakeScriptModel, fixture, type Fixture } from "./run-fakes.test-helpers.js";

// Synthetic: an invented parcel desk; no real script, layer or session.
let fx: Fixture;
afterEach(() => fx.cleanup());

const BUILDER: BuilderRef = { id: "claude-print", version: "1", model: "fake-model", basePromptSha: "a".repeat(64) };
const UNDEFINED_TOKEN_LAYER = "export default () => <div id=\"parcels\">\n  <div style={{ background: \"var(--color-border-subtle)\" }}>12 parcels held</div>\n</div>;\n";
const THEME_TOKEN_LAYER = "export default () => <div id=\"parcels\">\n  <div style={{ background: \"var(--color-border-prominent)\" }}>12 parcels held</div>\n</div>;\n";

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

const passingCheck: LayerTextCheck = async () => [];

const resolveWith = (worker: BeatWorker) =>
  runOneStage({ stage: "resolve", inputs: customBeatInputs(fx.dataDir) }, fakeHost(fx, fakeScriptModel(), fakeRender(), { beatWorker: worker, layerTextCheck: passingCheck }));

describe("the colour token check on custom-layer builds", () => {
  it("a layer painting with an undefined colour token gets one rebuild naming it", async () => {
    // Arrange
    fx = fixture();
    const { packets, worker } = scriptedWorker(UNDEFINED_TOKEN_LAYER, THEME_TOKEN_LAYER);

    // Act
    const record = await resolveWith(worker);

    // Assert
    expect(packets).toHaveLength(2);
    expect(JSON.parse(packets[1]!).rebuild).toMatch(/^the last build paints with colour tokens the theme does not define.*line 2 \(--color-border-subtle\)/);
    const tree = path.join(runPaths(fx.dataDir, record.childRunId!).runDir, CUSTOM_LAYERS);
    expect(readFileSync(path.join(tree, "b1.tsx"), "utf8")).toBe(THEME_TOKEN_LAYER);
  });

  it("fails resolve naming the line when the rebuild still paints with the undefined token", async () => {
    // Arrange
    fx = fixture();
    const { packets, worker } = scriptedWorker(UNDEFINED_TOKEN_LAYER);

    // Act
    const run = resolveWith(worker);

    // Assert
    await expect(run).rejects.toThrow("custom layers not built: b1 (needs repair: the layer breaks qa's text rules after one rebuild: b1 line 2 paints with undefined token --color-border-subtle)");
    expect(packets).toHaveLength(2);
  });

  it("builds a layer that paints only with theme tokens in one model call", async () => {
    // Arrange
    fx = fixture();
    const { packets, worker } = scriptedWorker(THEME_TOKEN_LAYER);

    // Act
    await resolveWith(worker);

    // Assert
    expect(packets).toHaveLength(1);
  });
});
