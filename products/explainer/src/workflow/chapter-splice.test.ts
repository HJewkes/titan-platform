import type { StepRunOutcome } from "@titan-design/workflow";
import { describe, expect, it } from "vitest";
import { dailyScript } from "../daily-script.test-helpers.js";
import type { L0Result } from "../eval-l0.js";
import type { ScriptV1 } from "../script-schema.js";
import { repairRounds, type Call } from "./script-draft.js";

// Synthetic: the daily fixture's beats, marked failing by id. A beat fails row-x while its id is "bad-x-<index>".
const marked = (marks: Record<number, string>): ScriptV1 => {
  const base = dailyScript();
  return { ...base, beats: base.beats.map((beat, i) => (marks[i] ? { ...beat, id: `bad-${marks[i]}-${i}` } : beat)) };
};

const failing = (script: ScriptV1): L0Result[] => {
  const byRow = new Map<string, string[]>();
  for (const beat of script.beats) {
    const [, row] = /^bad-(\w+)-/.exec(beat.id) ?? [];
    if (row) byRow.set(row, [...(byRow.get(row) ?? []), beat.id]);
  }
  return [...byRow].map(([row, beats]) => ({ check_id: `row-${row}`, mode: "tagged" as const, severity: "error" as const, value: 0, threshold: 1, pass: false, detail_beats: beats }));
};

// Daily fixture beat indexes: 0 bottom-line-1, 1 goals-1, 6 ships-1, 7 ships-2, 9 stats-1.
const BOTTOM_LINE = 0;
const GOALS = 1;
const SHIPS_1 = 6;
const SHIPS_2 = 7;
const STATS = 9;

/** Two rounds: the first reply is kept, and the second is the one the splice reads. */
async function repairTwice(start: ScriptV1, replies: readonly [ScriptV1, ScriptV1]) {
  let calls = 0;
  const call: Call = async (): Promise<StepRunOutcome> => ({ ok: true, output: String(calls++) });
  const read = () => ({ script: replies[calls - 1]!, stripped: [] });
  return repairRounds(call, { script: start, stamps: [] }, { rounds: 2, failing, prompt: () => "", read, settle: (script) => ({ script, stamps: [] }) });
}

const ids = (script: ScriptV1, chapter: string) => script.beats.filter((beat) => beat.chapter === chapter).map((beat) => beat.id);

describe("a chapter splice of a rejected repair reply", () => {
  it("a rejected reply's chapter that clears its rows is spliced into the kept script", async () => {
    // Arrange: round 2 fixes ships but breaks goals, so it fails as many rows, one under a new rule, and is rejected
    const start = marked({ [BOTTOM_LINE]: "a", [SHIPS_1]: "b", [STATS]: "d" });
    const replies = [marked({ [BOTTOM_LINE]: "a", [SHIPS_1]: "b" }), marked({ [BOTTOM_LINE]: "a", [GOALS]: "c" })] as const;

    // Act
    const repaired = await repairTwice(start, replies);

    // Assert
    expect(repaired.rows.map((row) => row.check_id)).toEqual(["row-a"]);
    expect(ids(repaired.script, "ships")).toEqual(["ships-1", "ships-2"]);
    expect(ids(repaired.script, "goals")).toEqual(["goals-1"]);
    expect(repaired.spliced).toEqual(["ships from repair-2"]);
  });

  it("a splice that only moves failures to another beat of its chapter is refused", async () => {
    // Arrange
    const start = marked({ [SHIPS_1]: "a", [STATS]: "d" });
    const replies = [marked({ [SHIPS_1]: "a" }), marked({ [SHIPS_2]: "a" })] as const;

    // Act
    const repaired = await repairTwice(start, replies);

    // Assert
    expect(repaired.script).toEqual(replies[0]);
    expect(repaired.spliced).toEqual([]);
  });

  it("a start no reply improved takes no splice, so a code-made start never becomes the answer", async () => {
    // Arrange
    const start = marked({ [BOTTOM_LINE]: "a", [SHIPS_1]: "b" });
    const call: Call = async (): Promise<StepRunOutcome> => ({ ok: true, output: "" });
    const rejected = marked({ [BOTTOM_LINE]: "a", [GOALS]: "c" });

    // Act
    const repaired = await repairRounds(call, { script: start, stamps: [] }, { rounds: 1, failing, prompt: () => "", read: () => ({ script: rejected }), settle: (script) => ({ script, stamps: [] }) });

    // Assert
    expect(repaired.script).toEqual(start);
    expect(repaired.spliced).toEqual([]);
  });
});
