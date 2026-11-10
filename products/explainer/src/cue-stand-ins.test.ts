import { describe, expect, it } from "vitest";
import { cueStandIns } from "./cue-stand-ins.js";
import { checkedObject, type ScriptPlan } from "./workflow/script-draft.js";
import { scriptWith } from "./script-fixtures.test-helpers.js";

const beatWith = (targets: string[]) => scriptWith({ visual: { assertion: "A beat", job: "map", cues: targets.map((target) => ({ action: "V11", target, atCue: "server" })) } }).beats[0]!;

describe("run, detail and note standing in for terminal or timeline beats", () => {
  // Mutation: dropping a generic kind from GENERIC_KINDS leaves that kind's stand-in unflagged.
  it.each([["run"], ["detail"], ["note"]])("flags %s carrying a typed command", (kind) => {
    const beat = beatWith([`${kind}:$ pnpm test`]);

    expect(cueStandIns(beat)).toEqual([{ target: `${kind}:$ pnpm test`, replacement: "cmd" }]);
  });

  // Mutation: dropping the out shape leaves output lines under detail unflagged.
  it("flags output lines and dated events", () => {
    const beat = beatWith(["detail:3 passed, 1 failed", "note:Mar 3 release cut", "note:2026-03-09 fix lands"]);

    expect(cueStandIns(beat).map((s) => s.replacement)).toEqual(["out", "event", "event"]);
  });

  it("leaves ordinary run, detail and note cues, and the dedicated kinds, alone", () => {
    const beat = beatWith(["run:merge queue", "detail:why it matters", "note:Marcus owns it", "cmd:$ pnpm test", "event:Mar 3 release cut"]);

    expect(cueStandIns(beat)).toEqual([]);
  });

  // Mutation: dropping cueStandIns from cueKindFault accepts the draft.
  it("fails a draft script's check, naming the cue, the beat and the kind to use", () => {
    const script = scriptWith({ visual: { assertion: "A beat", job: "map", cues: [{ action: "V11", target: "run:$ pnpm test", atCue: "server" }] } });
    const plan: ScriptPlan = { structure: "goal-walk", leads: [], specs: new Map() };

    const result = checkedObject(script, plan);

    expect(result).toMatchObject({ error: expect.stringContaining(`cue target "run:$ pnpm test" in ${script.beats[0]!.id} is terminal or timeline content under a generic kind: use cmd:`) });
  });
});
