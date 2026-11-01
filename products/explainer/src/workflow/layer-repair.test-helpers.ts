import { mkdirSync } from "node:fs";
import path from "node:path";
import type { BeatWorker, BuilderRef, LayerBuild } from "../build/beat-worker.js";
import { fakeAgentChat, type FakeAgentChat } from "../build/fake-agent-chat.test-helpers.js";
import { resolveScript, visual } from "../resolve-fixtures.test-helpers.js";
import { ArtifactStore } from "./artifacts.js";
import { openState } from "./host.js";

// Synthetic: an invented parcel desk; no real script, facts, roster or session.
const BUILDER: BuilderRef = { id: "claude-print", version: "1", model: "fake-model", basePromptSha: "a".repeat(64) };
const CUSTOM = { visual: visual({ layer: "custom", anchors: ["B2:E5"] }), fact_ids: ["F-1"] };
const FACTS = JSON.stringify({ items: [{ id: "F-1", text: "Each scan waits for a ledger entry." }] });
export const BROKEN = "export default function Layer() {\n  return <div>;\n}\n";
export const REPAIRED = "export default function Layer() {\n  return <div id=\"ledger\" />;\n}\n";

/** A worker whose every build fails the compile gate, at a fixed price. */
export function brokenWorker() {
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

/** The stored inputs of a one-beat script whose beat resolves to a custom layer, with `visualPatch` over its visual. */
export function customBeatInputs(dataDir: string, visualPatch: Record<string, unknown> = {}): Record<string, string> {
  const db = openState(dataDir);
  try {
    const store = new ArtifactStore(dataDir, db);
    const beat = { ...CUSTOM, visual: { ...CUSTOM.visual, ...visualPatch } };
    const texts = { script: JSON.stringify(resolveScript([["b1", "WHAT", beat]])), facts: FACTS };
    return Object.fromEntries(Object.entries(texts).map(([name, text]) => [name, store.putText(text, name, { runId: "input", stage: "input" })]));
  } finally {
    db.close();
  }
}

/** A fake agent-chat beside the fixture's data dir, whose repair agent writes `repaired` and spends 10k in, 2k out. */
export function fakeAgentChatBeside(dataDir: string, repaired?: string): FakeAgentChat {
  const root = path.join(path.dirname(dataDir), "agent-chat");
  mkdirSync(root, { recursive: true });
  return fakeAgentChat(root, { ...(repaired === undefined ? {} : { repaired }), tokens: { input: 10_000, output: 2_000 } });
}
