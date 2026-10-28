import { describe, expect, it } from "vitest";
import { declareReadings, declareScriptReadings } from "./heteronym-readings.js";
import { unsettledHeteronyms } from "./lint-heteronyms.js";
import { checked, type ScriptPlan } from "./workflow/script-draft.js";
import { tour, withBeat } from "./voice-flow-fixtures.test-helpers.js";

// Synthetic parcel-desk lines; none quotes a real script.
const DECIDED = [
  ["a time unit after a number", "The desk run took about 18 minutes.", "The desk run took about 18 [minutes](=time)."],
  ["an adjective after an intensifier", "The label shows quite minute print.", "The label shows quite [minute](=tiny) print."],
  ["a time unit before a pause", "Wait a minute, then rescan.", "Wait a [minute](=time), then rescan."],
  ["a time unit counted by more", "Give it one more minute to settle.", "Give it one more [minute](=time) to settle."],
  ["a noun after a determiner", "The desk logs the use of the scanner.", "The desk logs the [use](=noun) of the scanner."],
  ["a verb after a modal", "Couriers can use the scanner.", "Couriers can [use](=verb) the scanner."],
  ["a verb after a negated do", "Couriers don't use the old scanner.", "Couriers don't [use](=verb) the old scanner."],
  ["a verb after a subject", "We record each scan.", "We [record](=verb) each scan."],
  ["an -s verb after its subject", "It records each scan.", "It [records](=verb) each scan."],
  ["an infinitive with an object", "Couriers need to use the scanner.", "Couriers need to [use](=verb) the scanner."],
  ["a past read after a passive", "The label was read twice.", "The label was [read](=past) twice."],
  ["a present read after a modal", "Couriers can read the label.", "Couriers can [read](=present) the label."],
] as const;

// Contexts one neighbour does not settle: each must stay bare so Q-V10 still asks for it.
const UNDECIDED = [
  ["a minute whose next word is open class", "Every minute counts at the desk."],
  ["a minute before a comparative", "Each scan takes a minute longer now."],
  ["a minute before a determiner", "It saves a minute each day."],
  ["a minute before an adverb", "The scan ran a minute too long."],
  ["a minute before a noun", "The scan shows a minute detail on the label."],
  ["the very minute", "The label printed at the very minute the scan landed."],
  ["a predicate minute", "The change is minute."],
  ["a minute opening the line", "Minute by minute the queue grows."],
  ["a noun after an adjective", "The scanner allows two hours of daily use."],
  ["a to before a pause", "The desk puts the scanner to use."],
  ["a to before a preposition", "The desk puts it to use across every depot."],
  ["a to before a noun", "Stock stays close to present levels."],
  ["an -s form after to", "The hook writes to records of each scan."],
  ["a determiner standing as the subject", "This records the scan time."],
  ["a pronoun each before an -s form", "Each records its own scan."],
  ["a subject after do in a question", "So why do records matter?"],
  ["a subject after a leading modal", "Can projects ship late?"],
  ["a base-form subject after a leading modal", "Can record labels ship late?"],
  ["a subject after a leading will", "Will records stay open?"],
  ["a subject after a modal in a wh-question", "Why can't records sync?"],
  ["a base-form subject after do", "Why do record labels matter?"],
  ["an imperative after a sentence break", "Sign in. Record each parcel."],
  ["an imperative after a question", "What is it for? Use the scanner."],
  ["an imperative opening the line", "Use the scanner daily."],
  ["an -s form after an object pronoun", "The desk shows you records of the scan."],
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
