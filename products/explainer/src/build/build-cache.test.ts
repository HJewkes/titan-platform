import { afterEach, describe, expect, it } from "vitest";
import { resolveScript, visual } from "../resolve-fixtures.test-helpers.js";
import { ArtifactStore } from "../workflow/artifacts.js";
import { openState, runOneStage } from "../workflow/host.js";
import { fakeRender, fakeHost, fakeScriptModel, fixture, type Fixture } from "../workflow/run-fakes.test-helpers.js";
import type { BeatWorker, BuilderRef, LayerBuild } from "./beat-worker.js";

// Synthetic: an invented parcel desk; no real script, facts, prompt or session.
let fx: Fixture;
afterEach(() => fx.cleanup());

const BUILDER: BuilderRef = { id: "claude-print", version: "1", model: "fake-model", basePromptSha: "a".repeat(64) };
const CUSTOM = { visual: visual({ layer: "custom", anchors: ["B2:E5"] }), fact_ids: ["F-1"] };
const FACTS = JSON.stringify({ items: [{ id: "F-1", text: "Each scan waits for a ledger entry." }] });
const BROKEN = "export default function Layer() {\n  return <div>;\n}\n";

function countingWorker(module?: string) {
  const calls: string[] = [];
  const worker: BeatWorker = {
    builder: BUILDER,
    build: async ({ packet }): Promise<LayerBuild> => {
      calls.push(packet.beat_id);
      const source = module ?? `export const Layer = () => "${packet.beat_id}";\n`;
      return { module: source, anchors: packet.anchors, elements: [], usage: { usd: 0.01, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, calls: 1 } };
    },
  };
  return { calls, worker };
}

const TEMPLATE = { visual: visual({ layer: "template" }), fact_ids: ["F-1"] };
const EDITED = { ...TEMPLATE, visual: visual({ layer: "template", assertion: "The desk logs every refusal" }) };

function pinInputs(second: typeof TEMPLATE = TEMPLATE): Record<string, string> {
  const db = openState(fx.dataDir);
  try {
    const store = new ArtifactStore(fx.dataDir, db);
    const put = (name: string, text: string) => store.putText(text, name, { runId: "input", stage: "input" });
    return { script: put("script", JSON.stringify(resolveScript([["b1", "WHAT", CUSTOM], ["b2", "WHAT", second]]))), facts: put("facts", FACTS) };
  } finally {
    db.close();
  }
}

const host = (worker: BeatWorker) => fakeHost(fx, fakeScriptModel(), fakeRender(), { beatWorker: worker });

describe("the layer build cache", () => {
  it("reads on the next run a build stored by an earlier run, with zero worker calls", async () => {
    fx = fixture();
    const pins = pinInputs();
    await runOneStage({ stage: "resolve", inputs: pins }, host(countingWorker().worker));
    const next = countingWorker();

    const record = await runOneStage({ stage: "resolve", inputs: pinInputs(EDITED) }, host(next.worker));

    expect(next.calls).toEqual([]);
    expect(record.notes).toContain("1 custom layers built (1 from the build cache)");
  });

  it("never stores a build that fails the compile gate, so the next run asks the worker again", async () => {
    fx = fixture();
    const pins = pinInputs();
    await expect(runOneStage({ stage: "resolve", inputs: pins }, host(countingWorker(BROKEN).worker))).rejects.toThrow(/needs repair/);
    const retry = countingWorker(BROKEN);

    await expect(runOneStage({ stage: "resolve", inputs: pins }, host(retry.worker))).rejects.toThrow(/needs repair/);

    expect(retry.calls).toEqual(["b1"]);
  });
});
