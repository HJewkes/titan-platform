import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { L0_CHECKS, runL0 } from "./eval-l0.js";
import { invariantSeatRow, journeyOrderRow } from "./lint-spine.js";
import { scriptWith } from "./script-fixtures.test-helpers.js";
import { ScriptSchema } from "./script-schema.js";
import { parseSpine, type SpineV1 } from "./spine-schema.js";

const PILOT = new URL("../fixtures/spike/pipeline-explainer/spine.md", import.meta.url);
const pilot = (): SpineV1 => parseSpine(readFileSync(PILOT, "utf8"));

const withChapters = (rows: ReadonlyArray<readonly [string, string[]]>): SpineV1 => ({
  ...pilot(),
  chapters: rows.map(([chapter, cited]) => ({ chapter, question: "q", rows: cited })),
});

describe("Q-E15 journey before architecture", () => {
  // Mutation: dropping the architecture-before-journey comparison lets the pilot's ch2 through.
  it("fails the pilot spine on ch2, whose architecture map comes before the first journey chapter", () => {
    const result = journeyOrderRow(pilot());

    expect(result).toMatchObject({ check_id: "Q-E15", severity: "error", pass: false, detail_beats: ["ch2"] });
  });

  it("passes the same spine with the journey chapters moved ahead of the architecture", () => {
    const base = pilot();
    const [journey, architecture] = [base.chapters.filter((c) => c.rows[0]?.startsWith("§3")), base.chapters.filter((c) => c.rows[0]?.startsWith("§4"))];

    const result = journeyOrderRow({ ...base, chapters: [...journey, ...architecture] });

    expect(result.pass).toBe(true);
  });

  // Mutation: comparing chapter ids as strings puts ch10 before ch2 and flags the correct order.
  it("orders ten chapters by position, not by id text", () => {
    const rows = Array.from({ length: 10 }, (_, i): [string, string[]] => [`ch${i + 1}`, i + 1 < 10 ? ["§3.1"] : ["§4.1"]]);

    expect(journeyOrderRow(withChapters(rows)).pass).toBe(true);
    expect(journeyOrderRow(withChapters([["ch10", ["§3.1"]], ["ch2", ["§4.1"]]])).pass).toBe(true);
    expect(journeyOrderRow(withChapters([["ch2", ["§4.1"]], ["ch10", ["§3.1"]]])).detail_beats).toEqual(["ch2"]);
  });

  it("lets one chapter that cites both the journey and the architecture be the first journey chapter", () => {
    expect(journeyOrderRow(withChapters([["ch1", ["§3.1", "§4.1"]]])).pass).toBe(true);
  });

  it("fails an architecture chapter when no chapter cites the journey at all", () => {
    expect(journeyOrderRow(withChapters([["ch1", ["§4.1"]]])).detail_beats).toEqual(["ch1"]);
  });

  it("fails a journey step whose why is a dash, naming the step", () => {
    const base = pilot();
    const journey = base.journey.map((step) => (step.n === 3 ? { ...step, why: "—" } : step));

    const result = journeyOrderRow({ ...base, chapters: [], journey });

    expect(result).toMatchObject({ pass: false, detail_beats: ["§3.3"] });
  });
});

describe("Q-E18 invariants are seated", () => {
  const spineWith = (journeyStep: { invariant: string | null; breaksToday: string | null }, mechanism: string | null): SpineV1 => ({
    ...pilot(),
    journey: [{ n: 1, step: "Scan", what: "a scan", why: "it is needed", ...journeyStep }],
    architecture: [{ part: "Desk", carries: ["1"], mechanism, constraint: null }],
  });

  it("passes the pilot spine, whose two invariants name a mechanism and a fact", () => {
    expect(invariantSeatRow(pilot()).pass).toBe(true);
  });

  it("fails an invariant with no §4 row and no fact id, naming its journey row", () => {
    const result = invariantSeatRow(spineWith({ invariant: "I1 one record a parcel", breaksToday: null }, null));

    expect(result).toMatchObject({ check_id: "Q-E18", severity: "error", pass: false, detail_beats: ["§3.1"] });
  });

  it("passes an invariant that only a fact id seats", () => {
    expect(invariantSeatRow(spineWith({ invariant: "I1 one record a parcel", breaksToday: "F3" }, null)).pass).toBe(true);
  });

  it("passes an invariant that only a §4 mechanism seats", () => {
    expect(invariantSeatRow(spineWith({ invariant: "I1 one record a parcel", breaksToday: null }, "dedupes scans by barcode (I1)")).pass).toBe(true);
  });

  // Mutation: counting a row with an empty mechanism cell as a seat passes this.
  it("does not count a §4 row with an empty mechanism cell, or one that states another invariant", () => {
    const step = { invariant: "I1 one record a parcel", breaksToday: null };

    expect(invariantSeatRow(spineWith(step, null)).pass).toBe(false);
    expect(invariantSeatRow(spineWith(step, "retries offline scans (I2)")).pass).toBe(false);
  });

  it("checks video.invariants too: one no row states fails, one a seated journey invariant states passes", () => {
    const spine = pilot();

    expect(invariantSeatRow(spine, ["Every parcel gets a colour"]).detail_beats).toEqual(["Every parcel gets a colour"]);
    expect(invariantSeatRow(spine, ["I1 a merge names the exact current head"]).pass).toBe(true);
  });
});

describe("the spine checks inside runL0", () => {
  const script = ScriptSchema.parse(scriptWith());
  const ids = (spine?: SpineV1) => runL0(script, undefined, L0_CHECKS, undefined, spine).map((r) => r.check_id);

  // Mutation: running the checks spine-less emits rows here and fails the first assertion.
  it("emits no Q-E15 or Q-E18 row without a spine, and one each with a spine", () => {
    expect(ids()).not.toContain("Q-E15");
    expect(ids()).not.toContain("Q-E18");
    expect(ids(pilot())).toEqual(expect.arrayContaining(["Q-E15", "Q-E18"]));
  });
});
