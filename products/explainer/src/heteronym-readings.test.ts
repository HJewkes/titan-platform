import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runL0 } from "./eval-l0.js";
import { declareReadings, declareScriptReadings } from "./heteronym-readings.js";
import { heteronymCheck, unsettledHeteronyms } from "./lint-heteronyms.js";
import { loadRuleRegistry } from "./rules.js";
import type { ScriptV1 } from "./script-schema.js";
import { parseSpine } from "./spine-schema.js";
import { checked, failingErrors, failureList, repairPrompt, repairRounds, type ScriptPlan } from "./workflow/script-draft.js";
import { GOOD_BEATS, tour, type BeatSpec } from "./voice-flow-fixtures.test-helpers.js";

// Synthetic parcel-desk lines; none quotes a real script.
const COUNTED = [
  ["digits before minutes", "The desk run took about 18 minutes.", "The desk run took about 18 [minutes](=time)."],
  ["a spelled number before minute", "Give it one minute to settle.", "Give it one [minute](=time) to settle."],
  ["a spelled decimal before minutes", "The run took eighteen point eight three minutes.", "The run took eighteen point eight three [minutes](=time)."],
  ["a hyphenated number before minutes", "The queue clears in twenty-five minutes.", "The queue clears in twenty-five [minutes](=time)."],
] as const;

// No numeral counts these, so the sentence's meaning decides; each stays bare for Q-V10 and the L0 repair.
const OPEN = [
  ["a minute detail", "The scan shows a minute detail on the label."],
  ["every minute counts", "Every minute counts at the desk."],
  ["the very minute", "The label printed at the very minute the scan landed."],
  ["a numeral ending its phrase before minutes", "The desk took 18, minutes before the van left."],
] as const;

// The positive control's own heteronyms declared, so Q-V10 fails on w2's line alone.
const withLine = (spoken: string): ScriptV1 =>
  tour(GOOD_BEATS.map(([id, chapter, fn, line, extra]): BeatSpec => [id, chapter, fn, id === "w2" ? spoken : line.replace(/\brefuses\b/g, "[refuses](=verb)").replace(/\brow\b/g, "[row](=line)"), extra]));
const w2 = (script: ScriptV1 | undefined): string | undefined => script?.beats.find((beat) => beat.id === "w2")?.spoken;

const PLAN: ScriptPlan = { structure: "goal-walk", leads: [], specs: new Map() };
const q10 = (script: ScriptV1) => failingErrors(runL0(script, undefined, [heteronymCheck]));
const lint = { spine: parseSpine(readFileSync(new URL("../fixtures/spike/pipeline-explainer/spine.md", import.meta.url), "utf8")), g2p: { tokens: () => [] } };

describe("declaring a counted minute", () => {
  it.each(COUNTED)("declares %s as time", (_name, bare, declared) => {
    // Catches: a numeral the rule does not recognise, leaving a minute whose reading the count settles to a model call.
    const result = declareReadings(bare);

    expect(result).toBe(declared);
    expect(unsettledHeteronyms(result)).toEqual([]);
  });

  it.each(OPEN)("leaves %s bare, so Q-V10 still fails it", (_name, bare) => {
    // Catches: the rule guessing a reading no numeral decides.
    const script = declareScriptReadings(withLine(bare));

    expect(w2(script)).toBe(bare);
    expect(q10(script).map((row) => [row.check_id, row.detail_beats])).toEqual([["Q-V10", ["w2"]]]);
  });

  it("keeps an existing declaration and a phoneme override as written", () => {
    const spoken = "Wait 2 [minutes](=time), then read the 3 [minute](/mˈɪnət/) log.";

    expect(declareReadings(spoken)).toBe(spoken);
  });
});

describe("the script stage's parsed reply", () => {
  it("arrives with each counted minute already declared", () => {
    // Catches: the draft and repair replies reaching L0 without the declarations, so a model call is spent on them.
    const reply = withLine("The desk run took about 18 minutes.");

    const result = checked({ ok: true, output: JSON.stringify(reply) }, PLAN);

    expect(result.error).toBeUndefined();
    expect(w2(result.script)).toBe("The desk run took about 18 [minutes](=time).");
  });
});

describe("the L0 repair of an undeclared heteronym", () => {
  it("names the word, its place and readings to the model, and keeps a reply that declares it", async () => {
    // Catches: Q-V10's details never reaching the repair prompt, or a model's declaration not passing Q-V10.
    const start = withLine("Every minute counts at the desk.");
    const fixed = withLine("Every [minute](=time) counts at the desk.");
    const prompts: string[] = [];
    const call = async (prompt: string) => (prompts.push(prompt), { ok: true, output: JSON.stringify(fixed) });

    const repaired = await repairRounds(call, { script: start, stamps: [] }, {
      rounds: 1,
      failing: q10,
      prompt: (script, rows) => repairPrompt("", script, failureList(rows, loadRuleRegistry(), script, lint)),
      read: (outcome) => checked(outcome, PLAN),
      settle: (script) => ({ script, stamps: [] }),
    });

    expect(prompts[0]).toContain('w2 "minute" (word 2; write [minute](=time) or [minute](=tiny))');
    expect(prompts[0]).toContain("the reading its sentence means");
    expect(repaired.after).toBe(0);
    expect(w2(repaired.script)).toBe("Every [minute](=time) counts at the desk.");
  });
});
