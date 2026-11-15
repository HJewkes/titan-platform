import { describe, expect, it } from "vitest";
import { FILLER, NAMING, tourOf } from "./hallmark-fixtures.test-helpers.js";
import { repairHint } from "./l0-repair-hints.js";
import { hallmarkCheck } from "./lint-hallmarks.js";
import { lint, type BeatSpec } from "./voice-flow-fixtures.test-helpers.js";
import { writingGateCheck } from "./writing-gate.js";

const specsOf = (lines: readonly string[], extras: Record<string, Record<string, unknown>> = {}): BeatSpec[] =>
  lines.map((line, i): BeatSpec => [`b${i + 1}`, "ch1", "WHAT", line, extras[`b${i + 1}`]]);

describe("the named-before-defined repair hint", () => {
  const TERM = "vent note";
  const SPEAKING = "Steam escapes through the vent note once the water boils, and the cook hears it.";
  const rowFor = (script: ReturnType<typeof tourOf>) => lint(script, [hallmarkCheck]).get("hallmark:named-before-defined")!;

  it("names the term, the beat that speaks it and the beat that declares it, and moving the declaration to the speaking beat passes", () => {
    const lines = [...FILLER.slice(0, 3), SPEAKING, ...FILLER.slice(3, 6)];
    const early = tourOf(specsOf(lines, { b6: { new_terms: [TERM] } }));
    const row = rowFor(early);

    const hint = repairHint(row, early) ?? "";

    expect(row.pass).toBe(false);
    expect(hint).toContain(`"${TERM}" is spoken in b4 but declared in b6`);

    const moved = tourOf(specsOf(lines, { b4: { new_terms: [TERM] } }));
    expect(rowFor(moved).pass).toBe(true);
  });
});

describe("the short-register repair hint", () => {
  const SHORT = "The kettle sits on the stove all day.";
  const rowFor = (script: ReturnType<typeof tourOf>) => lint(script, [writingGateCheck]).get("writing:short-register")!;

  it("states the measured mean and the 12-word floor, and joining the short sentences into longer ones passes", () => {
    const short = tourOf(specsOf(Array.from({ length: 25 }, () => SHORT)));
    const row = rowFor(short);

    const hint = repairHint(row, short) ?? "";

    expect(row.pass).toBe(false);
    expect(hint).toContain("average 8 words (at least 12 needed)");

    const joined = tourOf(specsOf(Array.from({ length: 13 }, () => "The kettle sits on the stove all day, because the cook keeps the water hot for tea.")));
    expect(rowFor(joined)).toMatchObject({ pass: true, value: 17 });
  });
});

describe("the naming-refrain repair hint", () => {
  it("quotes the naming lines with their beats and none of the filler", () => {
    const [first = "", ...rest] = NAMING;
    const specs: BeatSpec[] = [...FILLER, `${first} Steam rushes through it once the water boils.`, ...rest].map((line, i) => [`b${i + 1}`, "ch1", "WHAT", line]);
    const script = tourOf(specs);
    const row = lint(script, [hallmarkCheck]).get("hallmark:naming-refrain")!;

    const hint = repairHint(row, script) ?? "";

    expect(hint).toContain('b11 "That little whistle is called the vent note."');
    expect(hint).toContain("b13");
    expect(hint).not.toContain("garden");
    expect(hint).not.toContain("Steam rushes");
  });
});
