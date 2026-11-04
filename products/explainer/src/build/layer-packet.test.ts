import { describe, expect, it } from "vitest";
import { oneBeat, resolvedOne, visual } from "../resolve-fixtures.test-helpers.js";
import { buildLayerPacket } from "./layer-packet.js";

// Synthetic: an invented parcel desk; no real repo, script or facts.
const CUSTOM = { visual: visual({ layer: "custom", anchors: ["B2:E5"], scene: "a sorting desk seen from above" }), fact_ids: ["F-1", "F-9"] };
const FACTS = new Map([["F-1", { id: "F-1", kind: "text" as const, text: "Each scan waits for a ledger entry." }]]);

describe("custom-layer packet", () => {
  it("carries the beat's narration, grid cells, scene and the cited facts the run holds", () => {
    const beat = oneBeat("WHAT", CUSTOM);

    const { packet } = buildLayerPacket({ beat, resolved: resolvedOne("WHAT", CUSTOM), facts: FACTS });

    expect(packet).toMatchObject({ beat_id: "b1", chapter: "ch1", spoken: beat.spoken, anchors: ["B2:E5"], scene: "a sorting desk seen from above", planned_s: beat.plannedS });
    expect(packet.fact_ids).toEqual(["F-1", "F-9"]);
    expect(packet.sources.map((source) => source.id)).toEqual(["F-1"]);
  });

  it("refuses a beat the resolver gave a template layer", () => {
    const template = { visual: visual({ layer: "template" }) };

    const build = () => buildLayerPacket({ beat: oneBeat("WHAT", template), resolved: resolvedOne("WHAT", template), facts: FACTS });

    expect(build).toThrow("b1: resolved to a template layer, not a custom one");
  });

  it("refuses a packet over its byte cap", () => {
    const build = () => buildLayerPacket({ beat: oneBeat("WHAT", CUSTOM), resolved: resolvedOne("WHAT", CUSTOM), facts: FACTS, maxBytes: 100 });

    expect(build).toThrow(/b1: layer packet is \d+ bytes \(limit 100\)/);
  });
});
