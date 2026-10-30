import type { StepRunOutcome } from "@titan-design/workflow";
import { describe, expect, it } from "vitest";
import { dailyScript } from "../daily-script.test-helpers.js";
import type { L0Result } from "../eval-l0.js";
import type { ScriptV1 } from "../script-schema.js";
import { repairRounds, type Call } from "./script-draft.js";
import { keptOverSeed } from "./split-start.js";
import { MAX_REPAIR_ROUNDS } from "./model-stages.js";

// A beat is failing while its id starts with "bad-"; each row names the beats that carry its marker.
const markedScript = (...marks: string[]): ScriptV1 => {
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

async function repair(start: ScriptV1, reply: ScriptV1, rounds = 1) {
  const call: Call = async (): Promise<StepRunOutcome> => ({ ok: true, output: "" });
  return repairRounds(call, { script: start, stamps: [] }, {
    rounds,
    failing,
    prompt: () => "",
    read: () => ({ script: reply }),
    settle: (script) => ({ script, stamps: [] }),
  });
}

describe("the repair keeps partial progress", () => {
  it("a reply that clears some beats of the one failing row is kept for the next round", async () => {
    const start = markedScript("a", "a", "a");

    const repaired = await repair(start, markedScript("a"));

    expect(repaired.script).toEqual(markedScript("a"));
    expect(repaired.rows.map((row) => row.detail_beats.length)).toEqual([1]);
  });

  it("a reply that adds a failing row is refused even with fewer beats", async () => {
    const start = markedScript("a", "a", "b");

    const repaired = await repair(start, markedScript("a", "c"));

    expect(repaired.script).toEqual(start);
    expect(repaired.rows.map((row) => row.check_id)).toEqual(["row-a", "row-b"]);
  });

  it("a reply that fails the same beats is refused", async () => {
    const start = markedScript("a", "a");

    const repaired = await repair(start, markedScript("a", "a"));

    expect(repaired.script).toEqual(start);
  });

  it("a repair whose replies each clear a beat runs four model calls", async () => {
    const marks = (left: number) => markedScript(...Array<string>(left).fill("a"));
    let calls = 0;
    const call: Call = async () => ({ ok: true, output: String(calls++) });

    const repaired = await repairRounds(call, { script: marks(5), stamps: [] }, {
      rounds: MAX_REPAIR_ROUNDS,
      failing,
      prompt: () => "",
      read: () => ({ script: marks(5 - calls) }),
      settle: (script) => ({ script, stamps: [] }),
    });

    expect(calls).toBe(4);
    expect(repaired.script).toEqual(marks(1));
  });
});

describe("each round asks from the best reply so far", () => {
  it("a reply that swaps the row for one on fewer beats is the next round's draft and rows, though not kept", async () => {
    const start = markedScript("a", "a", "a");
    const replies = [markedScript("c"), markedScript("c", "c")];
    const asked: { script: ScriptV1; rows: string[] }[] = [];
    const call: Call = async () => ({ ok: true, output: "" });

    const repaired = await repairRounds(call, { script: start, stamps: [] }, {
      rounds: 2,
      failing,
      prompt: (script, rows) => {
        asked.push({ script, rows: rows.flatMap((row) => row.detail_beats) });
        return "";
      },
      read: () => ({ script: replies[asked.length - 1]! }),
      settle: (script) => ({ script, stamps: [] }),
    });

    expect(asked[1]).toEqual({ script: markedScript("c"), rows: ["bad-c-0"] });
    expect(repaired.script).toEqual(start);
  });
});

// Regression (TP-4565): a reply that swapped the seed's one row for another on as many beats was never asked from.
describe("a reply that ties the base under another rule", () => {
  it("is the next round's draft and rows, though not kept", async () => {
    const start = markedScript("a");
    const asked: string[][] = [];
    const call: Call = async () => ({ ok: true, output: "" });

    const repaired = await repairRounds(call, { script: start, stamps: [] }, {
      rounds: 2,
      failing,
      prompt: (_script, rows) => {
        asked.push(rows.map((row) => row.check_id));
        return "";
      },
      read: () => ({ script: markedScript("c") }),
      settle: (script) => ({ script, stamps: [] }),
    });

    expect(asked).toEqual([["row-a"], ["row-c"]]);
    expect(repaired.script).toEqual(start);
  });
});

describe("the repaired script over the seed", () => {
  const seed = { script: markedScript("a", "a", "a"), stamps: [] };

  it("is kept when it answers the same row on fewer beats", async () => {
    const repaired = await repair(seed.script, markedScript("a"));

    expect(keptOverSeed(repaired, seed, failing(seed.script)).script).toEqual(markedScript("a"));
  });

  it("is the seed when a split start brings in a row and the reply only trims it", async () => {
    const seeded = { script: markedScript("a", "a", "a", "x", "x"), stamps: [] };
    const repaired = await repair(markedScript("x", "x", "y", "y"), markedScript("x", "x", "y"));

    const kept = keptOverSeed(repaired, seeded, failing(seeded.script));

    expect(kept.script).toEqual(seeded.script);
    expect(kept.rows.map((row) => row.check_id)).toEqual(["row-a", "row-x"]);
  });

  it("is not the seed's split start left unanswered", async () => {
    const repaired = await repair(markedScript("a"), markedScript("a", "a"));

    expect(keptOverSeed(repaired, seed, failing(seed.script)).script).toEqual(seed.script);
  });
});
