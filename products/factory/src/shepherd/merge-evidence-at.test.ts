import { partialFake } from "@titan-design/test-kit";
import { describe, expect, it } from "vitest";
import type { Verdict } from "./phases.js";
import { mergeEvidenceAt } from "./policy.js";

const HEAD = "a".repeat(40);
const WELL_FORMED = { head: HEAD, merge: { changedPaths: ["src/a.ts"] }, record: { repo: "acme/gizmos" } };

const evidenceOf = (evidence: unknown) => mergeEvidenceAt(HEAD, () => partialFake<Verdict>({ kind: "MERGE", evidence }));

describe("the evidence a stored MERGE carries", () => {
  it("comes back whole, keeping fields the guard does not read", () => {
    const stored = { ...WELL_FORMED, carry: { fromHead: "b".repeat(40) }, mergeableState: "clean" };

    expect(evidenceOf(stored)).toEqual(stored);
  });

  it.each([
    ["no evidence", undefined],
    ["null evidence", null],
    ["text evidence", "MERGE"],
    ["no head", { ...WELL_FORMED, head: undefined }],
    ["null merge facts", { ...WELL_FORMED, merge: null }],
    ["merge facts with no changed paths", { ...WELL_FORMED, merge: {} }],
    ["null record", { ...WELL_FORMED, record: null }],
    ["an unread-files note that is no text", { ...WELL_FORMED, changedFilesUnread: 3 }],
  ])("reads %s as none, so the merge gates", (_case, evidence) => {
    expect(evidenceOf(evidence)).toBeUndefined();
  });
});
