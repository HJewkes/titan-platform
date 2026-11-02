import type { DiffPin } from "@titan-design/github";
import { describe, expect, it } from "vitest";
import { carriedThisEntry, carryRow, type CarriedMerge } from "./carry-rows.js";

const ITEM = { repo: "Fixture/Repo", pr: 7 };
const [REVIEWED, HEAD, EARLIER] = ["a".repeat(40), "b".repeat(40), "c".repeat(40)];
const CARRIED: CarriedMerge = { fromHead: REVIEWED, head: HEAD, rule: "remerge-empty", memoKey: `sh-merge-evidence:${HEAD}:0` };

const evidence = (head: string) => ({ data: { result: { record: { head, carry: { fromHead: REVIEWED, head } } } } });
const exact = (full: string, core: string): DiffPin => ({ kind: "exact", head: HEAD, base: "m1", main: "m1", full, core });

describe("carry rows", () => {
  it("a carry across a clean merge-up logs carry-agrees with exclusion2", () => {
    const probe = { reviewed: exact("f1", "c1"), current: exact("f2", "c1"), mergeUp: { ok: true, mainParent: "m1" }, headIsMerge: true, wsBlindCoreEqual: true } as const;
    expect(carryRow(ITEM, CARRIED, probe)).toEqual({
      family: "diff",
      class: "carry-agrees",
      materialValid: true,
      fullValid: false,
      drift: [],
      carry: { item: "fixture/repo#7", fromHead: REVIEWED, head: HEAD, rule: "remerge-empty", exclusion2: true },
    });
  });

  it("with no carry probe a carried MERGE is pin-differs unprobed", () => {
    expect(carryRow(ITEM, CARRIED, undefined)).toMatchObject({ class: "pin-differs", cause: "unprobed", materialValid: false, fullValid: false });
  });

  it("a carry recorded in an earlier entry is not logged again", () => {
    const stepResults = { [`sh-merge-evidence:${EARLIER}:0`]: evidence(EARLIER), "ci-wait:0": { data: { verdict: "green" } }, [`sh-merge-evidence:${HEAD}:0`]: evidence(HEAD) };
    const carried = carriedThisEntry(stepResults, [`sh-merge-evidence:${EARLIER}:0`, "ci-wait:0"]);
    expect(carried).toEqual([{ fromHead: REVIEWED, head: HEAD, rule: "tree-equal", memoKey: `sh-merge-evidence:${HEAD}:0` }]);
  });
});
