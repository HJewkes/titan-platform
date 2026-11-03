import { describe, expect, it } from "vitest";
import { runL0, type L0Result } from "./eval-l0.js";
import { sonnet } from "./judge-fakes.test-helpers.js";
import { bandDistance, chapterRefusal, rewriteScript } from "./rewrite-pass.js";
import { planRegisterEdits } from "./rewrite-plan.js";
import { ScriptSchema, type ScriptV1 } from "./script-schema.js";
import { scriptWith } from "./script-fixtures.test-helpers.js";
import { fakeRewriter, promptBeatIds } from "./rewrite-fixtures.test-helpers.js";
import { usePreCalibrationStatuses } from "./writing-statuses-fixtures.test-helpers.js";

usePreCalibrationStatuses();

const LINE = "Every scan passes one desk server before it reaches the ledger.";
const SAYS_ID = `${LINE} Ticket TP-7001 is still open.`;
const NAMES_IT = `${LINE} The dock ticket is still open.`;

/** One short beat, so every register row passes and only the spoken id can direct it. */
const sayingId = (): ScriptV1 => ScriptSchema.parse(scriptWith({ spoken: SAYS_ID, fact_ids: ["task/TP-7001/opened"] }));

const row = (check_id: string, value: number, threshold: number, pass: boolean, severity: "error" | "warning" = "warning"): L0Result => ({
  check_id, mode: "heuristic", severity, value, threshold, pass, detail_beats: [],
});

describe("a beat that says an id once the bands are met", () => {
  it("is directed to cut the id though no register row fails", async () => {
    const script = sayingId();

    const { directives } = planRegisterEdits(script, runL0(script));

    expect(directives).toEqual([{ beat: "c2-1-stations", chapter: "ch2", ids: ["TP-7001"] }]);
  });

  it("is rewritten without the id, though every target row already passed", async () => {
    const script = sayingId();
    const fake = fakeRewriter((id) => ({ id, spoken: NAMES_IT, labels_added: [] }));

    const { script: out, report } = await rewriteScript(script, { harness: fake.harness, judge: sonnet });

    expect(fake.prompts.flatMap(promptBeatIds)).toEqual(["c2-1-stations"]);
    expect(fake.prompts[0]).toContain("- Ids: this beat says");
    expect(report.rounds[0]).toMatchObject({ kept: true, rewritten: ["c2-1-stations"] });
    expect(out.beats[0]!.spoken).toBe(NAMES_IT);
  });
});

describe("chapterRefusal on a chapter that cuts ids", () => {
  const before = [row("register:sentence-mean", 6, 12.51, false), row("Q-V15", 2, 0, false, "error")];
  const cut = [row("register:sentence-mean", 6, 12.51, false), row("Q-V15", 1, 0, false, "error")];
  const cutButFarther = [row("register:sentence-mean", 5, 12.51, false), row("Q-V15", 1, 0, false, "error")];

  it("keeps a chapter that only cuts ids, though the distance to band holds", () => {
    expect(bandDistance(cut)).toBe(bandDistance(before));

    expect(chapterRefusal(before, cut, new Set())).toBeUndefined();
  });

  it("refuses a chapter that cuts an id but moves away from band", () => {
    expect(chapterRefusal(before, cutButFarther, new Set())).toEqual({ why: "the distance to band did not fall" });
  });
});
