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
const DECORATED = "export default () => <div id=\"parcels\" style={{ background: \"linear-gradient(red, blue), conic-gradient(red, blue)\", boxShadow: \"0 0 20px red\" }}>12 parcels held</div>;\n";
const PLAIN = "export default () => <div id=\"parcels\" style={{ background: \"linear-gradient(red, blue)\", boxShadow: \"4px 4px 0 #000\" }}>12 parcels held</div>;\n";

function workerAnswering(module: string): BeatWorker {
  return {
    builder: BUILDER,
    build: async ({ packet }): Promise<LayerBuild> => ({ module, anchors: packet.anchors, elements: [], usage: { usd: 0.01, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, calls: 1 } }),
  };
}

const passingCheck: LayerTextCheck = async () => [];

const resolveWith = (worker: BeatWorker) =>
  runOneStage({ stage: "resolve", inputs: customBeatInputs(fx.dataDir) }, fakeHost(fx, fakeScriptModel(), fakeRender(), { beatWorker: worker, layerTextCheck: passingCheck }));

describe("the style tells note on custom-layer builds", () => {
  it("notes a layer's decorative gradients and glows in the build notes and still builds it", async () => {
    // Arrange
    fx = fixture();

    // Act
    const record = await resolveWith(workerAnswering(DECORATED));

    // Assert
    expect(record.notes).toContain("b1 uses 2 gradients and 1 glow effect: decorative styling, kept as built");
    const tree = path.join(runPaths(fx.dataDir, record.childRunId!).runDir, CUSTOM_LAYERS);
    expect(readFileSync(path.join(tree, "b1.tsx"), "utf8")).toBe(DECORATED);
  });

  it("adds no note for one gradient and an offset hard shadow", async () => {
    // Arrange
    fx = fixture();

    // Act
    const record = await resolveWith(workerAnswering(PLAIN));

    // Assert
    expect(record.notes.filter((note) => note.includes("decorative styling"))).toEqual([]);
  });
});
