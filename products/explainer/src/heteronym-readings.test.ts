import { describe, expect, it } from "vitest";
import { declareReadings, declareScriptReadings } from "./heteronym-readings.js";
import { unsettledHeteronyms } from "./lint-heteronyms.js";
import { checked, type ScriptPlan } from "./workflow/script-draft.js";
import { tour, withBeat } from "./voice-flow-fixtures.test-helpers.js";

// Synthetic parcel-desk lines; none quotes a real script.
const DECIDED = [
  ["a time unit after a number", "The desk run took about 18 minutes.", "The desk run took about 18 [minutes](=time)."],
  ["an adjective after a", "The scan shows a minute detail on the label.", "The scan shows a [minute](=tiny) detail on the label."],
  ["a time unit before a pause", "Wait a minute, then rescan.", "Wait a [minute](=time), then rescan."],
  ["a noun after a determiner", "The desk logs each use of the scanner.", "The desk logs each [use](=noun) of the scanner."],
  ["a verb after a modal", "Couriers can use the scanner.", "Couriers can [use](=verb) the scanner."],
  ["a past read after a passive", "The label was read twice.", "The label was [read](=past) twice."],
] as const;

const UNDECIDED = [
  ["a minute whose next word is open class", "Every minute counts at the desk."],
  ["a noun after an adjective", "The scanner allows two hours of daily use."],
  ["a to before a pause", "The desk puts the scanner to use."],
] as const;

describe("declaring heteronym readings from context", () => {
  it.each(DECIDED)("declares %s", (_name, bare, declared) => {
    // Catches: a context rule that reads the wrong neighbour or names a reading the table does not have.
    const result = declareReadings(bare);

    expect(result).toBe(declared);
    expect(unsettledHeteronyms(result)).toEqual([]);
  });

  it.each(UNDECIDED)("leaves %s bare, so Q-V10 still fails it", (_name, bare) => {
    // Catches: a rule guessing a reading its context does not decide.
    expect(declareReadings(bare)).toBe(bare);
  });

  it("keeps an existing declaration and a phoneme override as written", () => {
    const spoken = "Couriers [read](=present) the [minute](/mˈɪnət/) log.";

    expect(declareReadings(spoken)).toBe(spoken);
  });

  it("declares only the occurrence its context decides and leaves Q-V10 naming the other by place", () => {
    const spoken = "Every minute counts, so the desk logs each minute.";

    const result = declareReadings(spoken);

    expect(result).toBe("Every minute counts, so the desk logs each [minute](=time).");
    expect(unsettledHeteronyms(result)).toEqual([{ word: "minute", readings: ["time", "tiny"], position: 2 }]);
  });

  it("declares across every beat of a script", () => {
    const script = tour(withBeat("w2", { spoken: "The desk run took about 18 minutes." }));

    const w2 = declareScriptReadings(script).beats.find((beat) => beat.id === "w2");

    expect(w2?.spoken).toBe("The desk run took about 18 [minutes](=time).");
  });
});

describe("the script stage's parsed reply", () => {
  it("arrives with the readings its context decides already declared", () => {
    // Catches: the draft and repair replies reaching L0 without the declarations, so a model call is spent on them.
    const reply = tour(withBeat("w2", { spoken: "The desk run took about 18 minutes." }));
    const plan: ScriptPlan = { structure: "goal-walk", leads: [], specs: new Map() };

    const result = checked({ ok: true, output: JSON.stringify(reply) }, plan);

    expect(result.error).toBeUndefined();
    expect(result.script?.beats.find((beat) => beat.id === "w2")?.spoken).toBe("The desk run took about 18 [minutes](=time).");
  });
});
