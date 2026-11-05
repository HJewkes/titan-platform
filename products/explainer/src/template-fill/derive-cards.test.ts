import { lineSourceFromTexts } from "@titan-design/evidence";
import { describe, expect, it } from "vitest";
import { fill, filledBeat, fillSolo, fixtureScript } from "./fill-fixtures.test-helpers.js";

describe("template fill: card beats", () => {
  it("draws a button with no action label as the outro card on the same component", () => {
    // Arrange
    const script = fixtureScript();

    // Act
    const found = filledBeat(fill(script), "b12");

    // Assert
    expect(found).toMatchObject({ spec: "outro", ref: "outro", component: "OutroBeat", slots: { line: "Check the row, then print" } });
    expect(found.fallback?.from).toBe("button");
  });

  it("keeps a button's second label as its action", () => {
    // Arrange / Act
    const found = fillSolo({ beat: "button", labels: ["Check the row", "Print"] });

    // Assert
    expect(found).toMatchObject({ spec: "button", slots: { line: "Check the row", action: "Print" } });
  });

  it("keeps a hook's later labels as cards, each on its cue", () => {
    // Arrange
    const script = fixtureScript();

    // Act
    const found = filledBeat(fill(script), "b1");

    // Assert
    expect(found.slots).toEqual({
      line: "The desk refuses a label",
      cards: [
        { id: "cards-1", text: "Lost parcel" },
        { id: "cards-2", text: "Late scan" },
      ],
    });
    expect(found.reveals).toEqual([
      { target: "line", atCue: "A" },
      { target: "cards-1", atCue: "parcel" },
      { target: "cards-2", atCue: "refuses" },
    ]);
  });

  it("numbers a chapter card and asks its question", () => {
    // Arrange / Act
    const found = fillSolo({ beat: "chapter" });

    // Assert
    expect(found.slots).toEqual({ n: 1, title: "The refusal", question: "Why would a desk refuse a label?" });
  });

  it("sources a claim card from its first chip with a fact id", () => {
    // Arrange
    const chips = [
      { kind: "our-framing", text: "Our read" },
      { kind: "verified", text: "Desk log", fact_id: "f-desk-log" },
    ];

    // Act
    const found = fillSolo({ beat: "claim-card", labels: ["The desk never guesses"], chips });

    // Assert
    expect(found.slots).toEqual({ claim: "The desk never guesses", source: { label: "Desk log", ref: "f-desk-log" } });
    expect(found.chips).toEqual([
      { kind: "our-framing", text: "Our read" },
      { kind: "verified", text: "Desk log" },
    ]);
  });

  it("promises the script's chapters when the beat names fewer than two", () => {
    // Arrange / Act
    const found = fillSolo({ beat: "promise" });

    // Assert
    expect(found.slots.chapters).toEqual([
      { id: "chapters-1", text: "The refusal" },
      { id: "chapters-2", text: "The scan path" },
      { id: "chapters-3", text: "The call" },
    ]);
  });

  it("follows the audience persona through the labels as steps", () => {
    // Arrange / Act
    const found = fillSolo({ beat: "user-flow", labels: ["Scan the parcel", "Print the label"] });

    // Assert
    expect(found.slots).toEqual({
      actor: "Night desk clerk",
      steps: [
        { id: "steps-1", text: "Scan the parcel" },
        { id: "steps-2", text: "Print the label" },
      ],
    });
  });

  it("lists takeaways and fact flashes from their labels", () => {
    // Arrange / Act
    const [takeaways, facts] = [fillSolo({ beat: "takeaways", labels: ["Check the row"] }), fillSolo({ beat: "fact-flash", labels: ["Two lanes"] })];

    // Assert
    expect(takeaways.slots).toEqual({ items: [{ id: "items-1", text: "Check the row" }] });
    expect(facts.slots).toEqual({ facts: [{ id: "facts-1", text: "Two lanes" }] });
  });
});

describe("template fill: code beats", () => {
  const code = lineSourceFromTexts({ "src/desk.ts": "export function hold(scan) {\n  return ledger.confirm(scan);\n}\n" });

  it("walks the cited lines from the code source, ids `lines-<n>`", () => {
    // Arrange
    const visual = { beat: "code-walk", job: "code-proof", code: { file: "src/desk.ts", lines: [1, 2] } };

    // Act
    const found = fillSolo(visual, undefined, { code });

    // Assert
    expect(found.slots).toEqual({
      path: "src/desk.ts",
      language: "typescript",
      mode: "plain",
      simplified: false,
      lines: [
        { id: "lines-1", text: "export function hold(scan) {" },
        { id: "lines-2", text: "  return ledger.confirm(scan);" },
      ],
    });
  });

  it("falls back to a list when the fill has no code source", () => {
    // Arrange
    const visual = { beat: "code-walk", job: "code-proof", code: { file: "src/desk.ts", lines: [1, 2] } };

    // Act
    const found = fillSolo(visual);

    // Assert
    expect(found.fallback).toEqual({ from: "code-walk", reason: "src/desk.ts is cited but the fill has no code source" });
  });
});
