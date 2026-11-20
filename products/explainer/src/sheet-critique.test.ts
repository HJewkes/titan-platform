import { describe, expect, it } from "vitest";
import { CRITIQUE_PASSES, critiqueScore, type CritiqueReply } from "./sheet-critique.js";

type Finding = CritiqueReply["findings"][number];

function finding(over: Partial<Finding> = {}): Finding {
  return { cell: { beat: "b1", t: 2.5 }, problem: "label clipped", change: "shorten label", tags: [], severity: 3, ...over };
}

function reply(over: Partial<CritiqueReply> = {}): CritiqueReply {
  return { pass: CRITIQUE_PASSES[0], findings: [], scores: { design: 10, clarity: 10, idea: 10, content: 10 }, ...over };
}

describe("critiqueScore", () => {
  it("weights design 0.4, clarity 0.3, idea 0.2 and content 0.1", () => {
    const replies = [reply({ scores: { design: 5, clarity: 10, idea: 0, content: 10 } })];

    const result = critiqueScore(replies);

    expect(result.overall).toBeCloseTo(6);
  });

  it("averages scores across passes", () => {
    const replies = [reply({ scores: { design: 4, clarity: 4, idea: 4, content: 4 } }), reply({ scores: { design: 8, clarity: 8, idea: 8, content: 8 } })];

    expect(critiqueScore(replies).overall).toBeCloseTo(6);
  });

  it("caps overall at 6.5 when a finding is tagged glow-or-gradient", () => {
    const replies = [reply({ findings: [finding({ tags: ["glow-or-gradient"] })] })];

    expect(critiqueScore(replies).overall).toBe(6.5);
  });

  it("a finding tagged glow is normalised and caps overall at 6.5", () => {
    const replies = [reply({ findings: [finding({ tags: ["glow"] })] })];

    expect(critiqueScore(replies).overall).toBe(6.5);
  });

  it("an unknown tag never caps", () => {
    const replies = [reply({ findings: [finding({ tags: ["sparkle", "glow-ish-thing"] })] })];

    const result = critiqueScore(replies);

    expect(result.overall).toBe(10);
    expect(result.scores.content).toBe(10);
    expect(result.top).toHaveLength(1);
  });

  it("caps content at 4 when a finding is tagged unsupported-number", () => {
    const replies = [reply({ findings: [finding({ tags: ["unsupported-number"] })] })];

    const result = critiqueScore(replies);

    expect(result.scores.content).toBe(4);
    expect(result.overall).toBeCloseTo(9.4);
  });

  it("applies both caps together", () => {
    const replies = [reply({ findings: [finding({ tags: ["unsupported-number", "glow-or-gradient"] })] })];

    const result = critiqueScore(replies);

    expect(result.scores.content).toBe(4);
    expect(result.overall).toBe(6.5);
  });

  it("drops a finding that names no cell, with its tags", () => {
    const replies = [reply({ findings: [finding({ cell: undefined, tags: ["glow-or-gradient"] })] })];

    const result = critiqueScore(replies);

    expect(result.top).toEqual([]);
    expect(result.overall).toBe(10);
  });

  it("returns the top 3 findings by severity as 't . where . problem -> change'", () => {
    const replies = [
      reply({
        findings: [
          finding({ severity: 1, problem: "p1" }),
          finding({ severity: 5, problem: "p5", cell: { beat: "b9", t: 12 } }),
          finding({ severity: 3, problem: "p3" }),
        ],
      }),
      reply({ findings: [finding({ severity: 4, problem: "p4" })] }),
    ];

    const result = critiqueScore(replies);

    expect(result.top).toEqual([
      "12s · b9 · p5 -> shorten label",
      "2.5s · b1 · p4 -> shorten label",
      "2.5s · b1 · p3 -> shorten label",
    ]);
  });

  it("rejects a reply that fails the schema", () => {
    const bad = { pass: "first-glance", findings: [], scores: { design: 11, clarity: 1, idea: 1, content: 1 } };

    expect(() => critiqueScore([bad])).toThrow();
  });
});
