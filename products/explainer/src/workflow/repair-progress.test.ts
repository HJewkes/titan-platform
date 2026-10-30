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
    expect([repaired.beatsBefore, repaired.beatsAfter]).toEqual([3, 1]);
  });

  it("a reply that adds a failing row is refused even with fewer beats", async () => {
    const start = markedScript("a", "a", "b");

    const repaired = await repair(start, markedScript("a", "c"));

    expect(repaired.script).toEqual(start);
    expect(repaired.beatsAfter).toBe(3);
  });

  it("a reply that fails the same beats is refused", async () => {
    const start = markedScript("a", "a");

    const repaired = await repair(start, markedScript("a", "a"));

    expect(repaired.script).toEqual(start);
  });

  it("a seeded repair runs up to four rounds", () => {
    expect(MAX_REPAIR_ROUNDS).toBe(4);
  });
});

describe("the repaired script over the seed", () => {
  const seed = { script: markedScript("a", "a", "a"), stamps: [] };

  it("is kept when it answers the same row on fewer beats", async () => {
    const repaired = await repair(seed.script, markedScript("a"));

    expect(keptOverSeed(repaired, seed, { rows: 1, beats: 3 }).script).toEqual(markedScript("a"));
  });

  it("is not the seed's split start left unanswered", async () => {
    const repaired = await repair(markedScript("a"), markedScript("a", "a"));

    expect(keptOverSeed(repaired, seed, { rows: 1, beats: 3 }).script).toEqual(seed.script);
  });
});
