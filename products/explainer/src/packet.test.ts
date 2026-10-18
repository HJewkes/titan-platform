import { describe, expect, it } from "vitest";
import { DEFAULT_PACKET_MAX_BYTES, buildPacket, type PacketInput, type ResolvedSource } from "./packet.js";
import { StoryboardSchema, type Beat } from "./storyboard.js";
import { loadVisualRouter, visualCard } from "./visual-router.js";

const CATALOG = new Map([
  ["code", "CodeWalk({ lines, highlight }): reveals the excerpt line by line"],
  ["stat", "Stat({ value, label }): counts up to value"],
]);

const EXCERPT: ResolvedSource = {
  id: "src-excerpt",
  kind: "code",
  text: "export function add(a: number, b: number) {\n  return a + b;\n}",
  cite: "src/add.ts:L1-L3@0000000",
};
const FACT: ResolvedSource = { id: "src-fact", kind: "text", text: "Twelve pull requests merged this week." };
const SOURCES = new Map([EXCERPT, FACT].map((s) => [s.id, s]));

function beat(fields: Partial<Beat> & Pick<Beat, "type">): Beat {
  const board = StoryboardSchema.parse({
    video_type: "daily",
    title: "Synthetic",
    chapters: [{ id: "intro", title: "Intro" }],
    beats: [{ id: "beat-01", duration_s: 5, spoken: "Adding two numbers.", ...fields }],
  });
  const [first] = board.beats;
  if (!first) throw new Error("fixture storyboard has no beat");
  return first;
}

const input = (b: Beat, extra: Partial<PacketInput> = {}): PacketInput => ({
  beat: b,
  videoType: "daily",
  catalog: CATALOG,
  sources: SOURCES,
  ...extra,
});

describe("buildPacket", () => {
  it("throws on a code beat whose sources hold no code excerpt", () => {
    const codeBeat = beat({ type: "code", sources: ["src-fact"] });

    expect(() => buildPacket(input(codeBeat))).toThrow("beat-01: code beat has no code excerpt");
  });

  it("throws on a code beat whose excerpt is blank", () => {
    const blank = new Map([["src-excerpt", { ...EXCERPT, text: "  \n" }]]);

    expect(() => buildPacket(input(beat({ type: "code", sources: ["src-excerpt"] }), { sources: blank }))).toThrow(
      "code beat has no code excerpt",
    );
  });

  it("builds a code beat with its excerpt, component API, chapter and video type", () => {
    const codeBeat = beat({ type: "code", chapter: "intro", sources: ["src-excerpt"] });

    const { packet, json, bytes } = buildPacket(input(codeBeat));

    expect(packet).toMatchObject({ beat_id: "beat-01", video_type: "daily", chapter: "intro", sources: [EXCERPT] });
    expect(packet.component_api).toBe(CATALOG.get("code"));
    expect(bytes).toBe(Buffer.byteLength(json));
  });

  it("does not require an excerpt for a non-code beat", () => {
    const { packet } = buildPacket(input(beat({ type: "stat", sources: ["src-fact"] })));

    expect(packet.sources).toEqual([FACT]);
  });

  it("throws when the packet exceeds the byte cap", () => {
    const statBeat = beat({ type: "stat", sources: ["src-fact"] });
    const { bytes } = buildPacket(input(statBeat));

    expect(() => buildPacket(input(statBeat, { maxBytes: bytes - 1 }))).toThrow(`packet is ${bytes} bytes (limit ${bytes - 1})`);
    expect(buildPacket(input(statBeat, { maxBytes: bytes })).bytes).toBe(bytes);
  });

  it("applies the default cap when none is given", () => {
    const huge = new Map([["src-fact", { ...FACT, text: "x".repeat(DEFAULT_PACKET_MAX_BYTES) }]]);

    expect(() => buildPacket(input(beat({ type: "stat", sources: ["src-fact"] }), { sources: huge }))).toThrow("bytes (limit 48000)");
  });

  it("throws on a source id the route step never resolved", () => {
    expect(() => buildPacket(input(beat({ type: "stat", sources: ["src-missing"] })))).toThrow("source src-missing was not resolved");
  });

  it("throws on a beat type with no catalog entry", () => {
    expect(() => buildPacket(input(beat({ type: "terminal" })))).toThrow("no catalog entry for beat type terminal");
  });

  it("carries only the lexicon entries the beat's text mentions", () => {
    const lexicon = { entries: [{ term: "CI", spoken: "C I" }, { term: "npm", spoken: "N P M" }] };
    const statBeat = beat({ type: "stat", spoken: "CI ran twelve times.", display: "CI runs" });

    const { packet } = buildPacket(input(statBeat, { lexicon }));

    expect(packet.lexicon).toEqual([{ term: "CI", spoken: "C I" }]);
  });

  it("carries a gap kind's warning, closest built type and not-this list", () => {
    const sankeyBeat = beat({ type: "stat", kind: "sankey", sources: ["src-fact"] });

    const { packet, json } = buildPacket(input(sankeyBeat));

    expect(packet.visual).toMatchObject({ type: "sankey", gap: true, closest: { type: "dependency-graph", component: "NetworkGraph" } });
    expect(packet.visual?.warning).toContain("Sankey is not built yet");
    expect(packet.visual?.not_this).toEqual([
      { when: "the stages only narrow, without splitting", use: "funnel" },
      { when: "the paths matter, not the amounts", use: "data-flow" },
    ]);
    expect(JSON.parse(json).visual.not_this).toHaveLength(2);
  });

  it("carries no visual card for a beat with no kind", () => {
    expect(buildPacket(input(beat({ type: "stat", sources: ["src-fact"] }))).packet).not.toHaveProperty("visual");
  });

  it("throws on a kind the router does not know", () => {
    expect(() => buildPacket(input(beat({ type: "stat", kind: "sankee", sources: ["src-fact"] })))).toThrow("kind sankee is not a visual-router type");
  });

  it("fits the largest router card under the default cap", () => {
    const router = loadVisualRouter();
    const [largest] = [...router.types].sort((a, b) => JSON.stringify(visualCard(b)).length - JSON.stringify(visualCard(a)).length);
    if (!largest) throw new Error("pinned router has no types");

    const { bytes } = buildPacket(input(beat({ type: "stat", kind: largest.id, sources: ["src-fact"] })));

    expect(bytes).toBeLessThan(DEFAULT_PACKET_MAX_BYTES / 4);
  });
});
