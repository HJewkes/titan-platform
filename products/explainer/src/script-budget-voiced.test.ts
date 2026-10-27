import { describe, expect, it } from "vitest";
import { loadBeatSpecs } from "./beat-load.js";
import { resolveBeats } from "./resolve-beat.js";
import { budgetVerdict, scriptBudgets } from "./resolve-budget.js";
import { choppy } from "./rewrite-fixtures.test-helpers.js";
import { draftBudgets, draftWordBudget } from "./script-budget.js";
import type { ScriptV1 } from "./script-schema.js";
import { spellSpokenNumbers } from "./spoken-numbers.js";
import { shippedVisualRouter } from "./visual-router.js";

// 28 tokens to wordsOf, so exactly at a 10 s concept beat's cap of 28 before the numbers are spelled.
const SPENDY =
  "The desk spent $2.55 on 14 merges today, and each merge cleared a ledger row that a courier had been waiting on since the first scan came in.";

const withSpoken = (script: ScriptV1, id: string, spoken: string): ScriptV1 =>
  ({ ...script, beats: script.beats.map((beat) => (beat.id === id ? { ...beat, spoken } : beat)) });

const plannedAt = (script: ScriptV1, seconds: number): ScriptV1 => ({ ...script, beats: script.beats.map((beat) => ({ ...beat, plannedS: seconds })) });

/** What resolve's word-budget gate sees: the rewritten script, whose numbers rewrite has spelled. */
const resolveRows = (script: ScriptV1) => {
  const specs = loadBeatSpecs();
  return scriptBudgets(script, resolveBeats(script.beats, specs, shippedVisualRouter()), specs).rows;
};

const spell = (draft: ScriptV1): ScriptV1 => ({ ...draft, beats: draft.beats.map(spellSpokenNumbers) });

const resolveVerdict = (draft: ScriptV1): { pass: boolean } => budgetVerdict(resolveRows(spell(draft)));

describe("the script stage's word budget counts the words the voice reads", () => {
  it("fails a beat at its cap by raw tokens once its numbers are spelled, naming the spelled count", () => {
    const draft = withSpoken(choppy(), "h1", SPENDY);
    expect(resolveRows(draft).find((row) => row.id === "h1")).toMatchObject({ words: 28, cap: 28 });

    const verdict = draftWordBudget(draft);

    expect(verdict.pass).toBe(false);
    expect(verdict.detail).toBe("over: h1 32/28 words (10 s at 2.8 w/s; 32 words need 12 s)");
  });

  it("passes the same beat with its numbers already written as words that fit", () => {
    const draft = withSpoken(choppy(), "h1", SPENDY.replace("$2.55 on 14", "little on many"));

    expect(draftWordBudget(draft)).toEqual({ pass: true, detail: "every beat and block within its cap" });
  });

  it.each([
    ["an under-planned draft", plannedAt(choppy(), 5)],
    ["a draft planned with room to spare", plannedAt(choppy(), 12)],
    ["a draft at its cap only before the numbers are spelled", withSpoken(choppy(), "h1", SPENDY)],
  ])("agrees with resolve's verdict on %s", (_, draft) => {
    const scriptStage = draftWordBudget(draft);

    expect(scriptStage.pass).toBe(resolveVerdict(draft).pass);
  });

  it("budgets the spelled draft with the rows resolve computes", () => {
    const draft = withSpoken(choppy(), "h1", SPENDY);

    const rows = draftBudgets(draft);

    expect(rows).toEqual(resolveRows(spell(draft)));
  });
});
