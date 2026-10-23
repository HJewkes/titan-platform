import { describe, expect, it } from "vitest";
import type { SpineCandidate } from "./audition-sample.js";
import { pickSpine } from "./audition-spine.js";
import { parseSpine } from "./spine-schema.js";

const PICK: SpineCandidate = {
  structure: "scqa", system: null, likelihood: 0.5, sentence: "The desk refuses ghost labels.",
  hook: { fact: "F1", line: "A parcel that does not exist." },
  blocks: [
    { id: "summary", question: "What does the change do?", facts: ["F1", "F2"], seconds: 20, beat: "verdict-card", covers: [] },
    { id: "proof", question: "What shows it holds?", facts: ["F2", "F3"], seconds: 30, beat: "proof", covers: [] },
  ],
  payoff: "proof", signatureLayer: "layer 1", cuts: [],
};
const FACTS = [
  { id: "F1", text: "The desk refuses a label | with no parcel." },
  { id: "F2", text: "A scan writes one ledger row." },
  { id: "F3", text: "The new test\nfails on the old desk." },
];

describe("an audition pick read as a story spine", () => {
  it("makes each block a journey step and a chapter, its first fact the why", () => {
    const spine = parseSpine(pickSpine("pr-overview-scqa", PICK, FACTS));

    expect(spine.id).toBe("pr-overview-scqa");
    expect(spine.journey.map(({ n, step, what, why }) => [n, step, what, why])).toEqual([
      [1, "summary", "What does the change do?", "The desk refuses a label | with no parcel."],
      [2, "proof", "What shows it holds?", "A scan writes one ledger row."],
    ]);
    expect(spine.chapters).toEqual([
      { chapter: "ch1", question: "What does the change do?", rows: ["§3.1"] },
      { chapter: "ch2", question: "What shows it holds?", rows: ["§3.2"] },
    ]);
  });

  it("ledgers each cited fact at the chapter that first cites it", () => {
    const spine = parseSpine(pickSpine("pr-overview-scqa", PICK, FACTS));

    expect(spine.ledger.map(({ item, definedIn, reusedIn }) => [item, definedIn, reusedIn])).toEqual([
      ["F1", "ch1", []],
      ["F2", "ch1", ["ch2"]],
      ["F3", "ch2", []],
    ]);
  });
});
