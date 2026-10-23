import { describe, expect, it } from "vitest";
import { runL0, type L0Result } from "./eval-l0.js";
import { repairHint } from "./l0-repair-hints.js";
import { flowCheck } from "./lint-flow.js";
import { heteronymCheck } from "./lint-heteronyms.js";
import { ledgerCheck } from "./lint-ledger.js";
import { whyCheck } from "./lint-why.js";
import type { ScriptV1 } from "./script-schema.js";
import { GOOD_BEATS, tour, withBeat, type BeatSpec } from "./voice-flow-fixtures.test-helpers.js";

const failing = (script: ScriptV1, id: string): L0Result => {
  const row = runL0(script, undefined, [flowCheck, whyCheck, heteronymCheck, ledgerCheck]).find((r) => r.check_id === id);
  expect(row?.pass, `${id} should fail`).toBe(false);
  return row!;
};

const hintFor = (script: ScriptV1, id: string): string | undefined => repairHint(failing(script, id), script);

describe("repair hints for rows whose value says too little", () => {
  it("Q-F4 names the thesis ref outside its slot and where it starts", () => {
    const script = tour(GOOD_BEATS, { thesis_refs: ["h1", "h2", "c1"] });

    expect(hintFor(script, "Q-F4")).toBe("the midpoint thesis ref h2 starts at 9 % of planned time; it must start between 35 % and 65 %");
  });

  it("Q-F4 names the early beat closest to voicing the mechanism and the words it never says", () => {
    const script = tour(GOOD_BEATS, { thesis_mechanism: "pallets ride a conveyor into the sorting hall at night" });

    expect(hintFor(script, "Q-F4")).toMatch(/^no beat before 20 % of planned time speaks 60 % of thesis_mechanism's content words \(closest: \w+, which never says pallet, .*conveyor/);
  });

  it("Q-F5 quotes the pivot form the check counts, and how many the draft has", () => {
    const script = tour(withBeat("w4", { spoken: "That is the whole job of the desk." }));

    expect(hintFor(script, "Q-F5")).toContain('has 0 (none) and needs exactly one');
    expect(hintFor(script, "Q-F5")).toContain('"Now, how does');
  });

  it("Q-F1 names the connective that opens too many linked beats", () => {
    const beats = GOOD_BEATS.map((s): BeatSpec => (["h2", "w2", "w3", "w4", "k2", "k3", "c2"].includes(s[0]) ? [s[0], s[1], s[2], `So ${s[3]}`, s[4]] : s));

    expect(hintFor(tour(beats), "Q-F1")).toMatch(/"so" opens \d+ of \d+ linked beats, past the 40 % one connective may carry/);
  });

  it("Q-F3 quotes the anchor and lists the HOW beats that never name it", () => {
    const script = tour(GOOD_BEATS, { running_example: { scenario: "Parcel P-7 arrives late", anchor: "parcel p-7" } });

    expect(hintFor(script, "Q-F3")).toBe(
      'running_example.anchor "parcel p-7" must appear as written in a HOOK beat and in 50 % of HOW beats (spoken, assertion, a label, a chip or the code file); HOW beats without it: k1, k2, k3',
    );
  });

  it("Q-F16 names the identifier the voice says first and where", () => {
    const script = tour(withBeat("h2", { spoken: "That refusal works because the GitHub desk checks every scan against the ledger." }));

    expect(hintFor(script, "Q-F16")).toMatch(/^the first identifier the voice says is "GitHub" in h2, after \d+ % of the words \(needs 40 %\)/);
  });

  it("Q-V10 names each undeclared heteronym with the declarations that would settle it", () => {
    const script = tour(withBeat("w2", { spoken: "The desk server will read each scan, so nothing prints early." }));

    expect(hintFor(script, "Q-V10")).toMatch(/; w2 "read" \(write \[read\]\(=\w+\) or \[read\]\(=\w+\)\)/);
  });

  it("names the beat and cue kind the item track counts as unknown, for the ledger and pace rows", () => {
    const script = tour(withBeat("w2", { extra: { visual: { assertion: "The desk holds the scan", job: "numbers", cues: [{ action: "V6", target: "runner", atCue: "holds" }] } } }));
    const row = (check_id: string): L0Result => ({ check_id, mode: "tagged", severity: "error", value: 1, threshold: 0, pass: false, detail_beats: ["w2"] });
    const hint = repairHint(row("Q-E17"), script);

    expect(hint).toMatch(/^the item track cannot read w2: unknown cue kind "runner"\. A cue target is kind:label, with kind one of job, inv,/);
    expect(repairHint(row("Q-E16"), script)).toBe(hint);
  });

  it("gives no hint for a row whose beats and value already say what to fix", () => {
    const script = tour(withBeat("c2", { spoken: "Check the row, then print the label for the courier at the desk today." }));

    expect(hintFor(script, "Q-F11")).toBeUndefined();
  });
});
