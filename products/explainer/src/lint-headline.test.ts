import { describe, expect, it } from "vitest";
import { runL0 } from "./eval-l0.js";
import { repairHint } from "./l0-repair-hints.js";
import { assertionCheck, assertionCheckWith, HEADLINE_CHARS_PER_LINE, hasSubjectAndVerb, headlineCheck, headlineLines } from "./lint-headline.js";
import { GOOD_BEATS, tour, withBeat } from "./voice-flow-fixtures.test-helpers.js";

const THREE_LINES =
  "The parcel desk compares every incoming label against the shelf ledger before anything prints, then refuses the stale ones and tells the courier why at once";
const TWO_LINES = "The parcel desk compares every incoming label against the shelf ledger before anything prints at all";

const rowFor = (headline: string) => {
  const script = tour(withBeat("w2", { extra: { visual: { assertion: headline, job: "artifact-filling" } } }));
  return runL0(script, undefined, [headlineCheck]).find((row) => row.check_id === "Q-V13")!;
};

describe("Q-V13 headline length", () => {
  it("fails a headline that wraps to three lines and names its beat", () => {
    expect(headlineLines(THREE_LINES)).toBe(3);
    expect(rowFor(THREE_LINES)).toMatchObject({ severity: "error", pass: false, detail_beats: ["w2"] });
  });

  it("passes a headline that wraps to two lines", () => {
    expect(headlineLines(TWO_LINES)).toBe(2);
    expect(rowFor(TWO_LINES)).toMatchObject({ pass: true, detail_beats: [] });
  });

  it("passes a script whose headlines are all short", () => {
    const row = runL0(tour(GOOD_BEATS), undefined, [headlineCheck])[0]!;

    expect(row.pass).toBe(true);
  });

  it("counts a single word wider than a line across the lines it needs", () => {
    expect(headlineLines("x".repeat(HEADLINE_CHARS_PER_LINE * 2 + 1))).toBe(3);
  });
});

const assertionRow = (assertion: string, extra: Record<string, unknown> = {}) => {
  const script = tour(withBeat("w2", { extra: { visual: { assertion, job: "artifact-filling" }, ...extra } }));
  return { script, row: runL0(script, undefined, [assertionCheck])[0]! };
};

describe("Q-D7 assertion headlines", () => {
  it("passes a short claim with a subject and a finite verb", () => {
    expect(hasSubjectAndVerb("The desk refuses unknown parcels")).toBe(true);
    expect(hasSubjectAndVerb("Every label gets checked")).toBe(true);
    expect(assertionRow("The ledger confirms each parcel first").row).toMatchObject({ check_id: "Q-D7", severity: "error", pass: true });
  });

  it("fails a topic label and a bare imperative, naming the beat", () => {
    expect(hasSubjectAndVerb("The courier's parcel route")).toBe(false);
    expect(hasSubjectAndVerb("Check the ledger")).toBe(false);
    expect(assertionRow("Ledger lookups at the desk").row).toMatchObject({ pass: false, detail_beats: ["w2"] });
  });

  it("fails a claim of eleven words and passes one of ten", () => {
    const tagger = () => ["DT", "VBZ"];
    const at = (words: number) => runL0(tour(withBeat("w2", { extra: { visual: { assertion: Array(words).fill("desk").join(" "), job: "numbers" } } })), undefined, [assertionCheckWith(tagger)])[0]!;

    expect(at(11)).toMatchObject({ pass: false, detail_beats: ["w2"] });
    expect(at(10)).toMatchObject({ pass: true });
  });

  it("fails a headline written after its narration and passes one written before", () => {
    const authored = (assertion_at: string) => ({ authored: { assertion_at, spoken_at: "2026-01-02T10:00:00Z" } });

    expect(assertionRow("The desk refuses unknown parcels", authored("2026-01-02T10:00:00.500Z")).row).toMatchObject({ pass: false });
    expect(assertionRow("The desk refuses unknown parcels", authored("2026-01-02T09:59:59Z")).row).toMatchObject({ pass: true });
  });

  it("hints each failing headline with what keeps it from asserting", () => {
    const { script, row } = assertionRow("Ledger lookups at the desk");

    expect(repairHint(row, script)).toMatch(/w2 "Ledger lookups at the desk" \(no-subject-verb\).*subject and a verb in at most 10 words/);
  });
});
