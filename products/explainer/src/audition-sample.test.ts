import { describe, expect, it } from "vitest";
import { promptSlots } from "./audition-fakes.test-helpers.js";
import { auditionPool } from "./audition-pool.js";
import { checkSample, samplePrompt, slotBlocks, type SampleContext } from "./audition-sample.js";
import { loadDoctrine } from "./doctrine-load.js";
import { buildMaterialMap } from "./material-map.js";
import { loadProfiles, profileFor, structureFor } from "./profile-load.js";

const set = loadProfiles();
const profile = profileFor(set, "repo-argument");
/** Synthetic: a pending decision, a central problem and three parallel lints. */
const facts = ["The owner should adopt the new cache.", "Builds are slow on every laptop.", "One lint flags long labels.", "One lint flags dark text.", "One lint flags clipped arrows."].map((text, i) => ({ id: `F${i + 1}`, text }));
const map = buildMaterialMap({ factsSha: "0".repeat(64), format: "facts-md", facts, profile, structures: set.structures, vocabulary: loadDoctrine().vocabulary.signals });
const pool = auditionPool(map, profile);
const ctx: SampleContext = {
  slots: pool.slots, structures: set.structures, profile, map, facts,
  blocks: new Map(pool.slots.map((s) => [s.structure, slotBlocks(profile, structureFor(set.structures, s.structure))])),
};

function validReply() {
  return pool.slots.map((slot, i) => {
    const blocks = ctx.blocks.get(slot.structure)!;
    return {
      structure: slot.structure, system: slot.system, likelihood: 0.3, sentence: "s", hook: { fact: "F1", line: "l" },
      blocks: blocks.map((b) => ({ id: b.id, question: "q", facts: ["F2"], seconds: 30, beat: b.beats[0]!, covers: i === 0 ? ["takeaway"] : [] })),
      payoff: blocks[1]!.id, signatureLayer: "x", cuts: [],
    };
  });
}

const check = (spines: unknown) => checkSample(ctx, JSON.stringify({ spines }));

describe("audition sampling reply", () => {
  it("the prompt lists every slot with its blocks and beats, and the facts by id", () => {
    const prompt = samplePrompt(ctx);

    expect(promptSlots(prompt).map((s) => s.structure)).toEqual(["scqa", "abt", "countdown"]);
    expect(promptSlots(prompt)[0]!.blocks.map((b) => b.id)).toEqual(profile.structure.order === "heuristic" ? profile.structure.macros.scqa : []);
    expect(prompt).toContain("- F2: Builds are slow on every laptop.");
    expect(prompt).toContain("state its likelihood");
  });

  it("a valid reply stands as the candidates", () => {
    expect(check(validReply())).toMatchObject({ issues: [], spines: expect.any(Array) });
  });

  it("refuses a reply with the wrong count, a swapped slot, unknown facts, a foreign beat, block or coverage item, or a stray payoff", () => {
    const reply = validReply();
    const [a, b, c] = reply;

    expect(check([a, b]).issues).toEqual(["need 3 spines, one per slot, got 2"]);
    expect(check([b, a, c]).issues[0]).toMatch(/^spines\.0: slot is scqa\/null, got abt\/null/);
    expect(check([{ ...a, hook: { fact: "F9", line: "l" } }, b, c]).issues).toEqual(["spines.0: unknown fact ids F9"]);
    expect(check([{ ...a, blocks: a!.blocks.map((x, i) => (i === 0 ? { ...x, beat: "gantt" } : x)) }, b, c]).issues[0]).toMatch(/^spines\.0\.situation\.beat: gantt is not one of/);
    expect(check([{ ...a, blocks: a!.blocks.slice(1) }, b, c]).issues[0]).toMatch(/^spines\.0\.blocks: need situation, complication/);
    expect(check([{ ...a, blocks: a!.blocks.map((x) => ({ ...x, covers: ["purpose"] })) }, b, c]).issues[0]).toMatch(/covers: purpose not coverage items/);
    expect(check([{ ...a, payoff: "nowhere" }, b, c]).issues).toEqual(["spines.0.payoff: nowhere is not a block id"]);
  });

  it("refuses a reply that is not JSON, or a likelihood outside (0, 1]", () => {
    expect(checkSample(ctx, "no object here").issues).toEqual(["the reply holds no JSON object"]);
    expect(check(validReply().map((s) => ({ ...s, likelihood: 0 })))).toMatchObject({ issues: expect.arrayContaining([expect.stringMatching(/^spines\.0\.likelihood/)]) });
  });

  it("refuses a daily spine that leads its stats block with metrics-panel, naming the kinds that derive", () => {
    // Arrange
    const daily = profileFor(set, "daily-overview");
    const dailyMap = buildMaterialMap({ factsSha: "0".repeat(64), format: "facts-md", facts, profile: daily, structures: set.structures, vocabulary: loadDoctrine().vocabulary.signals });
    const slots = auditionPool(dailyMap, daily).slots;
    const blocks = new Map(slots.map((s) => [s.structure, slotBlocks(daily, structureFor(set.structures, s.structure))]));
    const dailyCtx: SampleContext = { slots, structures: set.structures, profile: daily, map: dailyMap, facts, blocks };
    const spines = slots.map((slot) => ({
      structure: slot.structure, system: slot.system, likelihood: 0.3, sentence: "s", hook: { fact: "F1", line: "l" },
      blocks: blocks.get(slot.structure)!.map((b) => ({ id: b.id, question: "q", facts: ["F2"], seconds: 15, beat: b.id === "stats" ? "metrics-panel" : b.beats[0]!, covers: [] })),
      payoff: "goals", signatureLayer: "x", cuts: [],
    }));

    // Act
    const { issues } = checkSample(dailyCtx, JSON.stringify({ spines }));

    // Assert
    expect(slots.length).toBeGreaterThan(0);
    expect(issues).toEqual(slots.map((_, i) => `spines.${i}.stats.beat: metrics-panel is not one of stat, chart`));
  });
});
