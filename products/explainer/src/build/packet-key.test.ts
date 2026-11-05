import { describe, expect, it } from "vitest";
import { oneBeat, resolvedOne, visual } from "../resolve-fixtures.test-helpers.js";
import { BEAT_WORKER_IDS, packetKey, type BuilderRef } from "./beat-worker.js";
import { buildLayerPacket } from "./layer-packet.js";

// Synthetic: an invented parcel desk; no real repo, script or prompt.
const BUILDER: BuilderRef = { id: "claude-print", version: "1", model: "fake-model", basePromptSha: "a".repeat(64) };
const CUSTOM = { visual: visual({ layer: "custom" }), fact_ids: ["F-1"] };

const packetFor = (factText: string, beatId = "b1") => {
  const beat = { ...oneBeat("WHAT", CUSTOM), id: beatId };
  const resolved = { ...resolvedOne("WHAT", CUSTOM), id: beatId };
  return buildLayerPacket({ beat, resolved, facts: new Map([["F-1", { id: "F-1", kind: "text" as const, text: factText }]]) }).packet;
};

describe("custom-layer packet key", () => {
  it("gives the same packet built twice the same key", () => {
    const first = packetFor("The desk holds a scan until the ledger confirms it.");
    const again = packetFor("The desk holds a scan until the ledger confirms it.");

    expect(packetKey(again, BUILDER)).toBe(packetKey(first, BUILDER));
  });

  it("gives two packets for the same beat id that differ in one source line different keys", () => {
    const before = packetFor("The desk holds a scan until the ledger confirms it.");
    const after = packetFor("The desk holds a scan until the courier confirms it.");

    expect(before.beat_id).toBe(after.beat_id);
    expect(packetKey(after, BUILDER)).not.toBe(packetKey(before, BUILDER));
  });

  it("re-keys every packet when the base prompt changes", () => {
    const packets = [packetFor("Scans wait.", "b1"), packetFor("Scans wait.", "b2")];
    const edited: BuilderRef = { ...BUILDER, basePromptSha: "b".repeat(64) };

    const changed = packets.filter((packet) => packetKey(packet, edited) !== packetKey(packet, BUILDER));

    expect(changed).toHaveLength(packets.length);
  });

  it("re-keys a packet when the builder's model changes", () => {
    const packet = packetFor("Scans wait.");

    expect(packetKey(packet, { ...BUILDER, model: "other-model" })).not.toBe(packetKey(packet, BUILDER));
  });

  it("has exactly two beat workers, claude-print and agent-chat, and no fork runner", () => {
    expect([...BEAT_WORKER_IDS].sort()).toEqual(["agent-chat", "claude-print"]);
  });
});
