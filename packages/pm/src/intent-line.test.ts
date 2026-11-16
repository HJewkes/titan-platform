import { describe, expect, it } from "vitest";
import { IntentLineSchema } from "./planning.js";

const line = {
  id: "alpha/I3",
  section: "Standing direction",
  date: "2026-01-03",
  quote: "invented quote three",
  ref: "msg:0a1b2c3d4e5f6a7b",
};

function issuesOf(candidate: unknown): string[] {
  const result = IntentLineSchema.safeParse(candidate);
  if (result.success) throw new Error("expected the intent line to be refused");
  return result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
}

describe("IntentLineSchema", () => {
  it("accepts a dated, quoted, referenced line and one superseded by a later line", () => {
    const superseded = { ...line, section: "Superseded", superseded_by: "alpha/I4" };

    expect(IntentLineSchema.parse(line)).toEqual(line);
    expect(IntentLineSchema.parse(superseded)).toEqual(superseded);
  });

  it("refuses a line with no quote", () => {
    const { quote: _quote, ...withoutQuote } = line;

    expect(issuesOf(withoutQuote)).toEqual([expect.stringMatching(/^quote: /)]);
  });

  it("refuses a line whose quote is empty or spans lines", () => {
    expect(issuesOf({ ...line, quote: "" })).toEqual(["quote: quote is empty"]);
    expect(issuesOf({ ...line, quote: "first\nsecond" })).toEqual(["quote: quote must be one line"]);
  });

  it("refuses a line with no date or an impossible date", () => {
    const { date: _date, ...withoutDate } = line;

    expect(issuesOf(withoutDate)).toEqual([expect.stringMatching(/^date: /)]);
    expect(issuesOf({ ...line, date: "2026-02-31" })).toEqual([expect.stringMatching(/^date: .*YYYY-MM-DD/)]);
  });

  it("refuses an id outside <initiative>/I<n>, an unknown section and a free-text ref", () => {
    const issues = issuesOf({ ...line, id: "alpha/B3", section: "Hunches", ref: "two words" });

    expect(issues.map((issue) => issue.split(":")[0])).toEqual(["id", "section", "ref"]);
  });
});
