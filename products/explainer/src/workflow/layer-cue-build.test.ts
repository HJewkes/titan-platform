import { readFileSync } from "node:fs";
import path from "node:path";
import type { ProbedText } from "@titan-design/render-qa";
import { afterEach, describe, expect, it } from "vitest";
import type { BeatWorker, BuilderRef, LayerBuild } from "../build/beat-worker.js";
import { narrationRows, type LayerTextCheck } from "../build/layer-text.js";
import { runOneStage } from "./host.js";
import { CUSTOM_LAYERS } from "./layer-build.js";
import { customBeatInputs } from "./layer-repair.test-helpers.js";
import { runPaths } from "./run-dir.js";
import { fakeRender, fakeHost, fakeScriptModel, fixture, type Fixture } from "./run-fakes.test-helpers.js";

// Synthetic: an invented parcel desk whose narration is "The desk server holds each scan until the ledger confirms the parcel."
let fx: Fixture;
afterEach(() => fx.cleanup());

const BUILDER: BuilderRef = { id: "claude-print", version: "1", model: "fake-model", basePromptSha: "a".repeat(64) };
const LEDGER_CUE = { cues: [{ action: "V6", target: "scan-card", atCue: "ledger" }] };
const LITERAL_SECOND = `import { useBeatTime } from "@titan-design/react-ui/motion";
export default function Layer() {
  const { t } = useBeatTime();
  return <div id="scan-card" style={{ opacity: t > 6.4 ? 1 : 0 }}>Scan held</div>;
}
`;
const CUE_TIMED = `import { useBeatTime, useCue } from "@titan-design/react-ui/motion";
export default function Layer() {
  const { t } = useBeatTime();
  const at = useCue("ledger");
  return <div id="scan-card" style={{ opacity: t > at ? 1 : 0 }}>Scan held</div>;
}
`;
const span = (text: string) => `export default () => <span id="scans">${text}</span>;\n`;

/** A fake model that answers its packets with `modules` in turn, exposing `scan-card`, and keeps each packet it was sent. */
function scriptedWorker(...modules: string[]) {
  const packets: string[] = [];
  const worker: BeatWorker = {
    builder: BUILDER,
    build: async ({ packet, json }): Promise<LayerBuild> => {
      packets.push(json);
      const module = modules[Math.min(packets.length, modules.length) - 1]!;
      return { module, anchors: packet.anchors, elements: ["scan-card"], usage: { usd: 0.01, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, calls: 1 } };
    },
  };
  return { packets, worker };
}

const shown = (element: string, text: string): ProbedText => ({ text, px: 48, tag: "span", cls: "", element, lines: [], clips: [] });

/** Stands in for the rendered check: each `<span id>` of the source shows its text at the beat's end, held to qa's narration rules. */
const narrationCheck: LayerTextCheck = async ({ layer, packet }) => {
  const texts = [...layer.build.module.matchAll(/<span id="([\w-]+)">([^<]*)<\/span>/g)].map(([, id, text]) => shown(`span#${id}`, text!));
  return narrationRows(packet.beat_id, packet.spoken, [{ t: packet.planned_s - 0.05, texts }]);
};

const hostWith = (worker: BeatWorker) => fakeHost(fx, fakeScriptModel(), fakeRender(), { beatWorker: worker, layerTextCheck: narrationCheck });

const storedLayer = (childRunId: string) => readFileSync(path.join(runPaths(fx.dataDir, childRunId).runDir, CUSTOM_LAYERS, "b1.tsx"), "utf8");

describe("the cue-timing check on custom-layer builds", () => {
  it("a layer that times a cue target with a literal second gets one rebuild naming the cue", async () => {
    // Arrange
    fx = fixture();
    const { packets, worker } = scriptedWorker(LITERAL_SECOND, CUE_TIMED);

    // Act
    const record = await runOneStage({ stage: "resolve", inputs: customBeatInputs(fx.dataDir, LEDGER_CUE) }, hostWith(worker));

    // Assert
    expect(packets).toHaveLength(2);
    expect(JSON.parse(packets[1]!).rebuild).toMatch(/^the last build timed cue targets from literal seconds, not their cue words: "ledger" \(scan-card\): .*useCue\("ledger"\)/);
    expect(storedLayer(record.childRunId!)).toBe(CUE_TIMED);
  });

  it("fails resolve naming the cue word when the rebuild still times it with a literal second", async () => {
    // Arrange
    fx = fixture();
    const { packets, worker } = scriptedWorker(LITERAL_SECOND);

    // Act
    const run = runOneStage({ stage: "resolve", inputs: customBeatInputs(fx.dataDir, LEDGER_CUE) }, hostWith(worker));

    // Assert
    await expect(run).rejects.toThrow('custom layers not built: b1 (needs repair: the layer still times cue words without useCue after one rebuild: "ledger" (scan-card))');
    expect(packets).toHaveLength(2);
  });

  it("builds a layer that reads every cue word with useCue in one model call", async () => {
    // Arrange
    fx = fixture();
    const { packets, worker } = scriptedWorker(CUE_TIMED);

    // Act
    const record = await runOneStage({ stage: "resolve", inputs: customBeatInputs(fx.dataDir, LEDGER_CUE) }, hostWith(worker));

    // Assert
    expect(packets).toHaveLength(1);
    expect(storedLayer(record.childRunId!)).toBe(CUE_TIMED);
  });
});

describe("the narration check on custom-layer builds", () => {
  it("a layer drawing a number its narration never says gets one rebuild", async () => {
    // Arrange
    fx = fixture();
    const { packets, worker } = scriptedWorker(span("+ 7 more scans"), span("Scans held"));

    // Act
    const record = await runOneStage({ stage: "resolve", inputs: customBeatInputs(fx.dataDir) }, hostWith(worker));

    // Assert
    expect(packets).toHaveLength(2);
    expect(JSON.parse(packets[1]!).rebuild).toMatch(/unspoken-fact on span#scans "\+ 7 more scans" \(the narration never says 7: draw no number or name/);
    expect(storedLayer(record.childRunId!)).toBe(span("Scans held"));
  });

  it("a card repeating five narration words gets one rebuild", async () => {
    // Arrange
    fx = fixture();
    const { packets, worker } = scriptedWorker(span("holds each scan until the ledger"), span("Scan held for the ledger"));

    // Act
    const record = await runOneStage({ stage: "resolve", inputs: customBeatInputs(fx.dataDir) }, hostWith(worker));

    // Assert
    expect(packets).toHaveLength(2);
    expect(JSON.parse(packets[1]!).rebuild).toMatch(/narration-echo on span#scans "holds each scan until the ledger" \(show key words, not the sentence/);
    expect(storedLayer(record.childRunId!)).toBe(span("Scan held for the ledger"));
  });

  it("fails resolve naming the number when the rebuild still draws it", async () => {
    // Arrange
    fx = fixture();
    const { worker } = scriptedWorker(span("+ 7 more scans"));

    // Act
    const run = runOneStage({ stage: "resolve", inputs: customBeatInputs(fx.dataDir) }, hostWith(worker));

    // Assert
    await expect(run).rejects.toThrow('the layer breaks qa\'s text rules after one rebuild: b1 span#scans unspoken-fact "+ 7 more scans" at 9.95 s');
  });
});
