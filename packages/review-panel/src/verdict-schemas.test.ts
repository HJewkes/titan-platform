import { describe, expect, it } from "vitest";
import { MAX_OWNER_BRIEF_CHARS } from "./reviewer-brief.js";
import { parseOwnerBrief, readMalformed } from "./verdict-schemas.js";

const HEAD = "a".repeat(40);
const VERDICT = `Looked at it.\n\nVerdict: MERGE\nPR: octo/demo#7\nHead: ${HEAD}\n`;
const BRIEF = [
  "OWNER-BRIEF",
  "What: Adds a retry to the widget sync.",
  "Why: It changes how every widget is synced.",
  "Pros:",
  "- Fewer dropped syncs.",
  "Cons:",
  "- Unreviewed timing change.",
  "- Slower failure reports.",
  "Door: one-way",
  "END-OWNER-BRIEF",
].join("\n");

describe("parseOwnerBrief", () => {
  it("reads the fields of a block that follows the verdict", () => {
    expect(parseOwnerBrief(`${VERDICT}\n${BRIEF}\n`)).toEqual({
      what: "Adds a retry to the widget sync.",
      why: "It changes how every widget is synced.",
      pros: ["Fewer dropped syncs."],
      cons: ["Unreviewed timing change.", "Slower failure reports."],
      doorType: "one-way",
    });
  });

  it("is null when the reviewer wrote no block", () => {
    expect(parseOwnerBrief(VERDICT)).toBeNull();
  });

  it("is null when the block comes before the verdict", () => {
    expect(parseOwnerBrief(`${BRIEF}\n${VERDICT}`)).toBeNull();
  });

  it.each([
    ["a door type that is neither", BRIEF.replace("one-way", "maybe")],
    ["no cons", BRIEF.replace(/Cons:[\s\S]*Door/, "Door")],
    ["a line that fits no field", BRIEF.replace("Door: one-way", "Door: one-way\nStray words")],
    ["a repeated field", BRIEF.replace("Door: one-way", "Door: one-way\nDoor: two-way")],
    ["two blocks", `${BRIEF}\n${BRIEF}`],
    ["a block over the length bound", BRIEF.replace("Adds a retry", "x".repeat(MAX_OWNER_BRIEF_CHARS))],
  ])("is null for %s", (_scenario, block) => {
    expect(parseOwnerBrief(`${VERDICT}\n${block}\n`)).toBeNull();
  });
});

describe("readMalformed", () => {
  it("reads the record from a stored none output", () => {
    expect(readMalformed({ kind: "none", malformed: { refusal: "bad_head", writtenAt: 12 }, extra: 1 })).toEqual({ refusal: "bad_head", writtenAt: 12 });
  });

  it.each([
    ["an output without the record", { kind: "none" }],
    ["a verdict output", { kind: "verdict", malformed: { refusal: "bad_head", writtenAt: 12 } }],
    ["an unknown refusal", { kind: "none", malformed: { refusal: "constructor", writtenAt: 12 } }],
    ["a non-numeric time", { kind: "none", malformed: { refusal: "bad_head", writtenAt: "12" } }],
    ["a non-object", "none"],
    ["null", null],
  ])("is null for %s", (_scenario, output) => {
    expect(readMalformed(output)).toBeNull();
  });
});
