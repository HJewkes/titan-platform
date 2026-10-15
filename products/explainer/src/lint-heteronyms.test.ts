import { describe, expect, it } from "vitest";
import { l0HardPass, L0_CHECKS, runL0 } from "./eval-l0.js";
import { heteronymCheck } from "./lint-heteronyms.js";
import { GOOD_BEATS, lint, tour, type BeatSpec } from "./voice-flow-fixtures.test-helpers.js";

// The positive control says "refuses" and "row", both heteronyms; declared here, it is the clean baseline.
const DECLARED_BEATS: BeatSpec[] = GOOD_BEATS.map(([id, chapter, fn, spoken, extra]) => [
  id,
  chapter,
  fn,
  spoken.replace(/\brefuses\b/g, "[refuses](=verb)").replace(/\brow\b/g, "[row](=line)"),
  extra,
]);

const withSpoken = (id: string, spoken: string, extra: Record<string, unknown> = {}): BeatSpec[] =>
  DECLARED_BEATS.map((spec) => (spec[0] === id ? [id, spec[1], spec[2], spoken, { ...spec[4], ...extra }] : spec));

const heteronyms = (beats: BeatSpec[]) => lint(tour(beats), [heteronymCheck]).get("Q-V10");

// Synthetic lines shaped like the three narration heteronyms the tagger probe saw flip under a different tagger:
// past "read" after a list of past verbs, present "read" after "cannot", and noun "use" after "of".
const FLIPPING = [
  ["past read", "The desk logged the scans, read the labels, and printed none.", "The desk logged the scans, [read](=past) the labels, and printed none."],
  ["present read after cannot", "The courier cannot read a parcel's barcode.", "The courier cannot [read](=present) a parcel's barcode."],
  ["noun use", "The scanner allows two hours of daily use.", "The scanner allows two hours of daily [use](=noun)."],
] as const;

describe("Q-V10 heteronym declarations", () => {
  it("passes a script whose every heteronym is declared", () => {
    expect(heteronyms(DECLARED_BEATS)).toMatchObject({ value: 0, pass: true, severity: "error", detail_beats: [] });
  });

  it("flags the undeclared heteronyms in the positive control", () => {
    // Catches: a table lookup that misses inflected forms ("refuses") or the check skipping beats.
    expect(heteronyms(GOOD_BEATS)?.detail_beats).toEqual(["h1", "k1", "k2", "c2"]);
  });

  it.each(FLIPPING)("fails an undeclared %s and passes it once declared", (_name, bare, declared) => {
    // Catches: the lint passing an undeclared occurrence, or not honouring a [w](=reading) declaration.
    expect(heteronyms(withSpoken("w3", bare))).toMatchObject({ value: 1, pass: false, detail_beats: ["w3"] });
    expect(heteronyms(withSpoken("w3", declared))?.pass).toBe(true);
  });

  it("reads the spoken text, not the visual, so a heteronym only in spoken is flagged", () => {
    // Catches: linting the visual fields in place of spoken; this beat's visual holds no heteronym.
    const beats = withSpoken("w3", "The courier cannot read a parcel's barcode.", {
      visual: { assertion: "The barcode stays unscanned", job: "numbers", labels: ["Barcode"] },
    });

    expect(heteronyms(beats)?.detail_beats).toEqual(["w3"]);
  });

  it("ignores a heteronym that appears only in the visual fields", () => {
    // Catches: linting the visual fields alongside spoken, which the voice never says.
    const beats = withSpoken("w3", "The courier waits for the barcode.", {
      visual: { assertion: "Couriers read the barcode", job: "numbers", labels: ["Live scans"] },
    });

    expect(heteronyms(beats)?.pass).toBe(true);
  });

  it("accepts a phoneme override in place of a declaration", () => {
    expect(heteronyms(withSpoken("w3", "The scan is [live](/lˈIv/) on the desk."))?.pass).toBe(true);
  });

  it("fails a declaration naming a reading the table does not have", () => {
    // Catches: a typo in a declaration silently counting as declared.
    expect(heteronyms(withSpoken("w3", "The desk [read](=pasted) the labels."))?.detail_beats).toEqual(["w3"]);
  });

  it("binds a declaration to its own occurrence, so a second bare one is flagged", () => {
    // Catches: a declaration keyed by word alone, covering every occurrence in the line.
    expect(heteronyms(withSpoken("w3", "The desk [read](=past) the label, then read it again."))?.pass).toBe(false);
  });

  it("runs among the L0 checks and fails the hard pass", () => {
    // Catches: the check written but never registered, or registered as a warning.
    const rows = runL0(tour(withSpoken("w3", "The scanner allows two hours of daily use.")), undefined, L0_CHECKS);

    expect(rows.find((row) => row.check_id === "Q-V10")).toMatchObject({ pass: false, detail_beats: ["w3"] });
    expect(l0HardPass(rows.filter((row) => row.check_id === "Q-V10"))).toBe(false);
  });
});
