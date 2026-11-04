import { describe, expect, it } from "vitest";
import { runL0 } from "./eval-l0.js";
import { repairHint } from "./l0-repair-hints.js";
import { ScriptSchema, type ScriptV1 } from "./script-schema.js";
import { scriptWith } from "./script-fixtures.test-helpers.js";
import { spokenIds, spokenIdsCheck } from "./spoken-ids.js";
import { spellSpokenNumbers } from "./spoken-numbers.js";

const PULL = "pr/acme/depot#6420/merged";
const TICKET = "task/TP-7001/opened";

function scriptSaying(spoken: string, fact_ids: string[] = [PULL]): ScriptV1 {
  return ScriptSchema.parse(scriptWith({ spoken, fact_ids }));
}

const idsIn = (spoken: string, fact_ids: string[] = [PULL]): string[] => spokenIds(scriptSaying(spoken, fact_ids).beats[0]!).map((id) => id.text);

const spelled = (spoken: string): string => spellSpokenNumbers({ spoken, visual: scriptSaying(spoken).beats[0]!.visual }).spoken;

describe("ids a spoken line says", () => {
  it("finds a pull request or ticket id in digits", () => {
    const ids = idsIn("So the landing that counts is PR 6420, and TP-7001 waits for your ruling.", [PULL, TICKET]);

    expect(ids).toEqual(["PR 6420", "TP-7001"]);
  });

  it("finds the same ids once the speller has read them in pairs", () => {
    const line = spelled("So the landing that counts is pull request 6420, and TP-7001 waits for your ruling.");

    const ids = idsIn(line, [PULL, TICKET]);

    expect(ids).toEqual(["pull request sixty-four twenty", "TP seventy oh one"]);
  });

  it("finds a cited id said bare, in digits or in either spelling", () => {
    const lines = ["Then 6420 turned the guard on.", "Then sixty-four twenty turned the guard on.", "Then six thousand four hundred twenty turned the guard on."];

    const found = lines.map((line) => idsIn(line));

    expect(found).toEqual([["6420"], ["sixty-four twenty"], ["six thousand four hundred twenty"]]);
  });

  it("finds script ids for facts, map steps and items", () => {
    const ids = idsIn("F7 says the desk waits, and M0-M10 walk the queue while I1 and g10-adversary hold.", ["F7", "g10-adversary"]);

    expect(ids).toEqual(["F7", "M0-M10", "I1", "g10-adversary"]);
  });

  it("finds nothing in a line that names the change by what it did", () => {
    const ids = idsIn("So the landing that counts is the guard fix, and one ticket waits for your ruling on the queue.", [PULL, TICKET]);

    expect(ids).toEqual([]);
  });

  it("does not take a real count beside a ticket for an id", () => {
    const ids = idsIn("Of the open tickets one of them waits, and forty-two crates moved through the dock today.", [PULL, TICKET]);

    expect(ids).toEqual([]);
  });
});

describe("Q-V15 spoken ids", () => {
  it("fails a beat whose line says an id and passes one that does not", () => {
    const [saying, silent] = [scriptSaying("Then TP seventy oh one turned the guard on."), scriptSaying("Then the guard fix turned the guard on.")];

    const rows = [saying, silent].map((script) => runL0(script, undefined, [spokenIdsCheck]));

    expect(rows.map(([row]) => [row!.check_id, row!.severity, row!.pass, row!.detail_beats])).toEqual([
      ["Q-V15", "error", false, ["c2-1-stations"]],
      ["Q-V15", "error", true, []],
    ]);
  });

  it("gives a repair hint that quotes the id and says where it goes instead", () => {
    const script = scriptSaying("Then PR 6420 turned the guard on.");
    const [row] = runL0(script, undefined, [spokenIdsCheck]);

    const hint = repairHint(row!, script);

    expect(hint).toContain('c2-1-stations "PR 6420"');
    expect(hint).toContain("by what it did");
  });
});
