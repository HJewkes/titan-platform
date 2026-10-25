import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentChatRepairer } from "../build/agent-chat-repairer.js";
import type { BeatWorker, BuilderRef, LayerBuild } from "../build/beat-worker.js";
import { FAKE_SESSION_ID, fakeAgentChat } from "../build/fake-agent-chat.test-helpers.js";
import { resolveScript, visual } from "../resolve-fixtures.test-helpers.js";
import { ArtifactStore } from "./artifacts.js";
import { openState, runOneStage } from "./host.js";
import { CUSTOM_LAYERS } from "./layer-build.js";
import { StageRecordSchema } from "./records.js";
import { readJson, runPaths } from "./run-dir.js";
import { fakeBridge, fakeHost, fakeScriptModel, fixture, type Fixture } from "./run-fakes.test-helpers.js";

// Synthetic: an invented parcel desk, a fake agent-chat and a one-request transcript; no real script, roster or session.
let fx: Fixture;
afterEach(() => fx.cleanup());

const BUILDER: BuilderRef = { id: "claude-print", version: "1", model: "fake-model", basePromptSha: "a".repeat(64) };
const CUSTOM = { visual: visual({ layer: "custom", anchors: ["B2:E5"] }), fact_ids: ["F-1"] };
const FACTS = JSON.stringify({ items: [{ id: "F-1", text: "Each scan waits for a ledger entry." }] });
const BROKEN = "export default function Layer() {\n  return <div>;\n}\n";
const REPAIRED = "export default function Layer() {\n  return <div id=\"ledger\" />;\n}\n";

/** A worker whose every build fails the compile gate, at a fixed price. */
function brokenWorker() {
  const calls: string[] = [];
  const worker: BeatWorker = {
    builder: BUILDER,
    build: async ({ packet }): Promise<LayerBuild> => {
      calls.push(packet.beat_id);
      return { module: BROKEN, anchors: packet.anchors, elements: [], usage: { usd: 0.01, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, calls: 1 } };
    },
  };
  return { calls, worker };
}

function inputs(): Record<string, string> {
  const db = openState(fx.dataDir);
  try {
    const store = new ArtifactStore(fx.dataDir, db);
    const texts = { script: JSON.stringify(resolveScript([["b1", "WHAT", CUSTOM]])), facts: FACTS };
    return Object.fromEntries(Object.entries(texts).map(([name, text]) => [name, store.putText(text, name, { runId: "input", stage: "input" })]));
  } finally {
    db.close();
  }
}

function hostWith(worker: BeatWorker, repaired?: string) {
  const root = path.join(path.dirname(fx.dataDir), "agent-chat");
  mkdirSync(root, { recursive: true });
  const fake = fakeAgentChat(root, { ...(repaired === undefined ? {} : { repaired }), tokens: { input: 10_000, output: 2_000 } });
  const layerRepairer = agentChatRepairer({ agentChatBin: fake.bin, profilesDir: fake.profilesDir, claudeConfigDir: fake.configDir, pollMs: 1 });
  return { fake, host: fakeHost(fx, fakeScriptModel(), fakeBridge(), { beatWorker: worker, layerRepairer }) };
}

const failedRecords = () => readdirSync(path.join(fx.dataDir, "runs"))
  .map((runId) => readJson(runPaths(fx.dataDir, runId).failed("resolve"), StageRecordSchema))
  .filter((record) => record !== undefined);

describe("the repair round on a custom layer that fails the compile gate", () => {
  it("spawns one repair agent, stores the module it wrote, and counts its transcript-priced spend with its session id", async () => {
    fx = fixture();
    const { host, fake } = hostWith(brokenWorker().worker, REPAIRED);

    const record = await runOneStage({ stage: "resolve", inputs: inputs() }, host);

    const tree = path.join(runPaths(fx.dataDir, record.childRunId!).runDir, CUSTOM_LAYERS);
    expect(fake.spawn()?.argv).toContain("--brief-stdin");
    expect(record.outputs[CUSTOM_LAYERS]).toBeDefined();
    expect(readFileSync(path.join(tree, "b1.tsx"), "utf8")).toBe(REPAIRED);
    expect(record.usage.usd).toBeCloseTo(0.05, 10);
    expect(record.usage).toMatchObject({ calls: 2 });
    expect(record.usage.costUnknown).toBeUndefined();
    expect(JSON.parse(readFileSync(path.join(tree, "layers.json"), "utf8"))).toMatchObject({ layers: [{ beat: "b1", repairSessionId: FAKE_SESSION_ID }] });
  });

  it("keeps a repair that still fails marked for repair, with its spend and session, and never caches it", async () => {
    fx = fixture();
    const pins = inputs();
    const { host } = hostWith(brokenWorker().worker, BROKEN);

    const run = runOneStage({ stage: "resolve", inputs: pins }, host);

    await expect(run).rejects.toThrow(new RegExp(`b1 \\(needs repair: still fails after repair \\(repair session ${FAKE_SESSION_ID}\\): layer\\.tsx:\\d+:\\d+: `));
    const [failed] = failedRecords();
    expect(failed?.usage.usd).toBeCloseTo(0.05, 10);
    expect(failed?.usage.costUnknown).toBeUndefined();
    const retry = brokenWorker();
    await expect(runOneStage({ stage: "resolve", inputs: pins }, hostWith(retry.worker, BROKEN).host)).rejects.toThrow(/still fails after repair/);
    expect(retry.calls).toEqual(["b1"]);
  });

  it("keeps the build marked for repair, with the repair's spend, when the agent wrote no module", async () => {
    fx = fixture();
    const { host } = hostWith(brokenWorker().worker);

    const run = runOneStage({ stage: "resolve", inputs: inputs() }, host);

    await expect(run).rejects.toThrow(/b1 \(needs repair: layer\.tsx:.*; the repair wrote no module \(repair session /);
    expect(failedRecords()[0]?.usage.usd).toBeCloseTo(0.05, 10);
    expect(existsSync(path.join(fx.dataDir, "layer-builds"))).toBe(false);
  });
});
