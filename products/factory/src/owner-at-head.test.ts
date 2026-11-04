import { fakeSha } from "@titan-design/github";
import { describe, expect, it } from "vitest";
import { OWNER_AT_HEAD_LEAD, ownerAtHeadRowsIn } from "./owner-at-head.js";
import { approveMergeAsk } from "./workflows/land-approval.js";

/** TP-4141: the marker line land writes on an approve-merge gate, read back; all text is synthetic. */
const HEAD = fakeSha("owner-at-head-marker");
const QUESTION = { repo: "example-org/example-repo", pr: 7, headSha: HEAD, round: 0, reason: "policy" };
const FIRST = `Merge PR #7 in example-org/example-repo at head ${HEAD}? CI is green. Policy shepherd-seat/none: policy`;

describe("the owner-at-head marker", () => {
  it("names the rule's own merge-guard row on a gate whose facts report none", () => {
    for (const rowId of ["ci-policy-weakened", "ci-policy-malformed", "files-unread", "skill-path"]) {
      const { prompt } = approveMergeAsk({ table: "shepherd-merge-guard", rowId, version: 1 }, {}, QUESTION);

      expect(ownerAtHeadRowsIn(prompt)).toEqual([rowId]);
    }
  });

  it("reads a marker naming no known row as owner-at-head, so a mangled one fails closed", () => {
    expect(ownerAtHeadRowsIn(`${FIRST}\n${OWNER_AT_HEAD_LEAD}ci-policy-weaken.`)).toEqual(["owner-at-head"]);
  });

  it("reads `none` as no row, and a posed marker beside land's only adds rows", () => {
    expect(ownerAtHeadRowsIn(`${FIRST}\n${OWNER_AT_HEAD_LEAD}none.`)).toEqual([]);
    expect(ownerAtHeadRowsIn(`${FIRST}\n${OWNER_AT_HEAD_LEAD}skill-path.\n${OWNER_AT_HEAD_LEAD}none.`)).toEqual(["skill-path"]);
    expect(ownerAtHeadRowsIn(`${FIRST}\n\nReviewer's owner brief:`)).toBeUndefined();
  });
});
