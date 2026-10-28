import { describe, expect, it } from "vitest";
import { draftWordBudget, planFaults, retimeOverBudget, wordBudgetFaults } from "../script-budget.js";
import type { ScriptV1 } from "../script-schema.js";
import { tour, type BeatSpec } from "../voice-flow-fixtures.test-helpers.js";

// An invented parcel desk's daily, one chapter per goal-walk block; no line quotes a real video.
const WORDS = "the desk sorts each parcel by its dock and holds the rest until a courier asks".split(" ");
const said = (count: number): string => Array.from({ length: count }, (_, i) => WORDS[i % WORDS.length]).join(" ");

/** Each block's beat and its plannedS: 122 s in all, every beat at 20 words, under its concept cap of 2.8 w/s. */
const PLAN: [chapter: string, plannedS: number][] = [
  ["bottom-line", 15], ["goals", 20], ["lanes", 20], ["ships", 18], ["side-quests", 9], ["stats", 14], ["reflection", 18], ["ask", 8],
];

interface Beat {
  id: string;
  chapter: string;
  plannedS: number;
  words: number;
  fn?: string;
}

const BASE: Beat[] = PLAN.map(([chapter, plannedS]) => ({ id: `${chapter}-1`, chapter, plannedS, words: 20 }));

function daily(beats: readonly Beat[]): ScriptV1 {
  const specs = beats.map(({ id, chapter, plannedS, words, fn }): BeatSpec => [id, chapter, fn ?? "WHAT", said(words), { plannedS }]);
  const chapters = [...new Set(beats.map((beat) => beat.chapter))].map((id) => ({ id, label: `${id} · the desk`, question: `What did ${id} hold?` }));
  return { ...tour(specs, { thesis_refs: beats.slice(0, 3).map((beat) => beat.id) }, chapters), profile: "daily-overview" };
}

const withBeat = (id: string, patch: Partial<Beat>, beats: readonly Beat[] = BASE): Beat[] =>
  beats.map((beat) => (beat.id === id ? { ...beat, ...patch } : beat));

const plannedOf = (draft: ScriptV1, id: string): number | undefined => draft.beats.find((beat) => beat.id === id)?.plannedS;

describe("the script stage's word-budget re-time", () => {
  it("raises a beat one word over its cap to the seconds its words need, and names it", () => {
    const draft = daily(withBeat("reflection-1", { words: 51 }));
    expect(draftWordBudget(draft).detail).toBe("over: reflection-1 51/50 words (18 s at 2.8 w/s; 51 words need 19 s)");

    const { draft: retimed, moves } = retimeOverBudget(draft);

    expect(moves).toEqual(["reflection-1 18→19 s"]);
    expect(plannedOf(retimed, "reflection-1")).toBe(19);
    expect(draftWordBudget(retimed).pass).toBe(true);
  });

  it("leaves a beat 8 words over, which needs 3 more seconds, as it came, so the gate still fails", () => {
    const draft = daily(withBeat("side-quests-1", { words: 33 }));

    const { draft: retimed, moves } = retimeOverBudget(draft);

    expect(moves).toEqual([]);
    expect(retimed).toBe(draft);
    expect(draftWordBudget(retimed).detail).toBe("over: side-quests-1 33/25 words (9 s at 2.8 w/s; 33 words need 12 s)");
  });

  // The close is exempt from Q-F8's band, so only the re-time's own 20 s bound holds it.
  it("does not raise a 19 s close that needs 21 s past the 20 s beat band", () => {
    const draft = daily(withBeat("reflection-1", { plannedS: 19, words: 57, fn: "CLOSE" }));

    const { draft: retimed, moves } = retimeOverBudget(draft);

    expect(moves).toEqual([]);
    expect(plannedOf(retimed, "reflection-1")).toBe(19);
    expect(draftWordBudget(retimed).pass).toBe(false);
  });

  // A chapter reader re-times against word-budget faults alone, so no runtime fault backs the bound up.
  it.each([
    ["the plan faults", planFaults],
    ["the word-budget faults a chapter reader passes", wordBudgetFaults],
  ])("refuses a re-time that would plan the draft past the profile's 240 s maximum, measured by %s", (_, faults) => {
    const padding = [20, 20, 20, 20, 20, 18].map((plannedS, i): Beat => ({ id: `aside-${i + 1}`, chapter: "aside", plannedS, words: 20 }));
    const draft = daily(withBeat("reflection-1", { words: 51 }, [...BASE, ...padding]));
    expect(draft.beats.reduce((sum, beat) => sum + beat.plannedS, 0)).toBe(240);

    const { moves } = retimeOverBudget(draft, faults);

    expect(moves).toEqual([]);
  });

  it("refuses a re-time that would plan a chapter past its block's longest airtime", () => {
    const second: Beat = { id: "side-quests-2", chapter: "side-quests", plannedS: 6, words: 10 };
    const beats = withBeat("side-quests-1", { words: 26 }, [...BASE, second]);

    const { moves } = retimeOverBudget(daily(beats));
    const roomier = retimeOverBudget(daily(withBeat("side-quests-2", { plannedS: 5, words: 10 }, beats)));

    expect(moves).toEqual([]);
    expect(roomier.moves).toEqual(["side-quests-1 9→10 s"]);
  });

  it("never re-times a block over its cap, since the block's cap does not move with plannedS", () => {
    const lanes = [1, 2, 3, 4, 5, 6].map((n): Beat => ({ id: `lanes-${n}`, chapter: "lanes", plannedS: 20, words: 56 }));
    const draft = daily([...BASE.filter((beat) => beat.chapter !== "lanes"), ...lanes]);
    expect(draftWordBudget(draft).detail).toMatch(/^over: block lanes 336\/\d+ words/);

    const { draft: retimed, moves } = retimeOverBudget(draft);

    expect(moves).toEqual([]);
    expect(retimed).toBe(draft);
  });
});
