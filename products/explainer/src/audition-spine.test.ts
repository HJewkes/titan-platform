import { describe, expect, it } from "vitest";
import type { SpineCandidate } from "./audition-sample.js";
import { pickSpine, spokenHandle } from "./audition-spine.js";
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
      { chapter: "summary", question: "What does the change do?", rows: ["§3.1"], beat: "verdict-card" },
      { chapter: "proof", question: "What shows it holds?", rows: ["§3.2"], beat: "proof" },
    ]);
  });

  it("names the pick's structure", () => {
    expect(parseSpine(pickSpine("pr-overview-scqa", PICK, FACTS)).structure).toBe("scqa");
  });

  it("ledgers each cited fact at the chapter that first cites it", () => {
    const spine = parseSpine(pickSpine("pr-overview-scqa", PICK, FACTS));

    expect(spine.ledger.map(({ item, definedIn, reusedIn }) => [item, definedIn, reusedIn])).toEqual([
      ["F1", "summary", []],
      ["F2", "summary", ["proof"]],
      ["F3", "proof", []],
    ]);
  });

  // Mutation: keying the ledger by fact id lists "task/DM-7/opened", which no script ever names.
  it("ledgers a task or pull-request fact by the handle a script speaks, and keeps the fact ids to cite", () => {
    const daily: SpineCandidate = {
      ...PICK,
      hook: { fact: "task/DM-7/opened", line: "One task waits on the owner." },
      blocks: [
        { ...PICK.blocks[0]!, facts: ["task/DM-7/opened", "pr/acme/parcel-desk#412/merged"] },
        { ...PICK.blocks[1]!, facts: ["task/DM-7/owner-gated", "F3"] },
      ],
    };

    const markdown = pickSpine("daily-overview-scqa", daily, FACTS);
    const spine = parseSpine(markdown);

    expect(spine.ledger.map(({ item, definedIn, reusedIn }) => [item, definedIn, reusedIn])).toEqual([
      ["DM-7", "summary", ["proof"]],
      ["PR 412", "summary", []],
      ["F3", "proof", []],
    ]);
    expect(markdown).toContain("| DM-7 | task/DM-7/opened, task/DM-7/owner-gated |");
  });
});

describe("the spoken handle of a fact", () => {
  it("is the task id, PR and its number, or else the fact id itself", () => {
    expect(["task/DM-7/closed", "pr/acme/parcel-desk#412/opened", "session/s-1", "F2"].map(spokenHandle)).toEqual(["DM-7", "PR 412", "session/s-1", "F2"]);
  });
});
