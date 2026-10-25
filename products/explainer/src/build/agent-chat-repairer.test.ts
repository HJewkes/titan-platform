import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentChatRepairer, layerRepairerFor } from "./agent-chat-repairer.js";
import { oneBeat, resolvedOne, visual } from "../resolve-fixtures.test-helpers.js";
import { BEAT_WORKER_IDS, type RepairRequest } from "./beat-worker.js";
import { claudePrintWorker } from "./claude-print-worker.js";
import { FAKE_SESSION_ID, fakeAgentChat } from "./fake-agent-chat.test-helpers.js";
import { buildLayerPacket } from "./layer-packet.js";
import { BEAT_WORKERS } from "./worker-registry.js";

// Synthetic: an invented parcel-desk beat, a fake agent-chat and a one-request transcript.
let root: string;
afterEach(() => rmSync(root, { recursive: true, force: true }));

const CUSTOM = { visual: visual({ layer: "custom", anchors: ["B2:E5"] }), fact_ids: ["F-1"] };
const PACKET = buildLayerPacket({ beat: oneBeat("WHAT", CUSTOM), resolved: resolvedOne("WHAT", CUSTOM), facts: new Map() });
const BROKEN = "export default function Layer() {\n  return <div>;\n}\n";
const REPAIRED = "export default function Layer() {\n  return <div id=\"ledger\" />;\n}\n";
const ERROR = "layer.tsx:2:15: Unexpected end of file before a closing \"div\" tag";

function request(): RepairRequest {
  return { packet: PACKET, key: "f".repeat(64), module: BROKEN, error: ERROR, scratchDir: path.join(root, "run", "layer-repairs", "f".repeat(64)) };
}

const repairerOn = (fake: ReturnType<typeof fakeAgentChat>) =>
  agentChatRepairer({ agentChatBin: fake.bin, profilesDir: fake.profilesDir, claudeConfigDir: fake.configDir, pollMs: 1, now: () => new Date("2026-10-25T00:00:00Z") });

describe("the agent-chat repair runner", () => {
  it("spawns the repair agent with the brief on stdin, never in argv", async () => {
    root = mkdtempSync(path.join(tmpdir(), "repair-"));
    const fake = fakeAgentChat(root, { repaired: REPAIRED });

    await repairerOn(fake).repair(request(), {});

    const { argv, brief } = fake.spawn()!;
    expect(argv).toEqual(["agent", "spawn", `layer-repair-${"f".repeat(16)}`, "beat-builder", "--brief-stdin"]);
    expect(argv.join(" ")).not.toContain(PACKET.packet.spoken);
    expect(brief).toContain(PACKET.json.trim());
    expect(brief).toContain(BROKEN.trim());
    expect(brief).toContain(ERROR);
    expect(brief).toContain(path.join(request().scratchDir, "b1.tsx"));
  });

  it("reads back the module the agent wrote, and prices its spend from its transcript by session id", async () => {
    root = mkdtempSync(path.join(tmpdir(), "repair-"));
    const fake = fakeAgentChat(root, { repaired: REPAIRED, tokens: { input: 10_000, output: 2_000 } });

    const repair = await repairerOn(fake).repair(request(), {});

    expect(repair.module).toBe(REPAIRED);
    expect(repair.sessionId).toBe(FAKE_SESSION_ID);
    expect(repair.usage.usd).toBeCloseTo(0.04, 10);
    expect(repair.usage).toMatchObject({ inputTokens: 10_000, outputTokens: 2_000, calls: 1 });
    expect(repair.usage.costUnknown).toBeUndefined();
  });

  it("returns no module, with the spend still priced, when the agent wrote nothing", async () => {
    root = mkdtempSync(path.join(tmpdir(), "repair-"));
    const fake = fakeAgentChat(root);

    const repair = await repairerOn(fake).repair(request(), {});

    expect(repair.module).toBeUndefined();
    expect(repair.usage.usd).toBeCloseTo(0.04, 10);
  });

  it("marks the spend unknown, not free, when the agent's transcript is not on this host", async () => {
    root = mkdtempSync(path.join(tmpdir(), "repair-"));
    const fake = fakeAgentChat(root, { repaired: REPAIRED });
    const elsewhere = agentChatRepairer({ agentChatBin: fake.bin, profilesDir: fake.profilesDir, claudeConfigDir: path.join(root, "other-config"), pollMs: 1 });

    const repair = await elsewhere.repair(request(), {});

    expect(repair.usage.costUnknown).toBe(true);
  });
});

describe("the beat worker registry", () => {
  it("holds exactly two runners, claude-print and agent-chat, and no fork runner", () => {
    const ids = Object.keys(BEAT_WORKERS);

    expect(ids.sort()).toEqual([...BEAT_WORKER_IDS].sort());
    expect(ids).toHaveLength(2);
    expect(BEAT_WORKERS["claude-print"]({ basePrompt: "base" }).builder.id).toBe("claude-print");
    expect(BEAT_WORKERS["agent-chat"]({ agentChatBin: "/bin/false" }).id).toBe("agent-chat");
    expect(claudePrintWorker).toBe(BEAT_WORKERS["claude-print"]);
  });
});

describe("the host's default repairer", () => {
  it("is agent-chat when a binary is configured, none without one, and none when set to null", () => {
    const configured = layerRepairerFor(undefined, { AGENT_CHAT_BIN: "/opt/fake/agent-chat" });
    const none = layerRepairerFor(undefined, { PATH: "" });
    const off = layerRepairerFor(null, { AGENT_CHAT_BIN: "/opt/fake/agent-chat" });

    expect(configured?.id).toBe("agent-chat");
    expect(none).toBeUndefined();
    expect(off).toBeUndefined();
  });
});
