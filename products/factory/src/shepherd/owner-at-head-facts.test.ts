import { fakeSha } from "@titan-design/github";
import { describe, expect, it } from "vitest";
import { ownerAtHeadRow } from "../coordinator-evidence.js";
import { approveMergeAsk } from "../workflows/land-approval.js";
import type { Verdict } from "./phases.js";
import { shepherdLandOptions, type EffectivePolicy } from "./policy.js";

/** TP-4141: Shepherd hands land each D21 fact its MERGE evidence holds, whatever rule the gate opens under; all text is synthetic. */
const REPO = "example-org/example-repo";
const HEAD = fakeSha("owner-at-head-facts");
const OWNER_GATE: EffectivePolicy = { merge: "owner-gate", mergeMethod: "squash", fixer: false, seat: "none" };
const SEAT_RULE = { table: "shepherd-seat", rowId: "none", version: 1 };
const VISUAL_RULE = { table: "shepherd-merge-guard", rowId: "visual-path", version: 1 };

/** A MERGE review at HEAD whose evidence carries `extra`; only the fields the policy reads are filled. */
const mergeWith =
  (extra: Record<string, unknown>, changedPaths: string[] = ["src/x.ts"]) =>
  (headSha: string): Verdict | undefined =>
    headSha === HEAD ? { kind: "MERGE", headSha, evidence: { head: HEAD, merge: { changedPaths }, record: {}, ...extra } } : undefined;

/** The gate land opens from Shepherd's options under `rule`, read back as the remote merge paths read it. */
function rowOfGate(verdictFor: (headSha: string) => Verdict | undefined, rule = SEAT_RULE) {
  const options = shepherdLandOptions(() => OWNER_GATE, verdictFor);
  const { prompt } = approveMergeAsk(rule, { ...options, reviewedMerge: () => true }, { repo: REPO, pr: 7, headSha: HEAD, round: 0, reason: "policy" });
  return { prompt, row: ownerAtHeadRow({ id: "run-1/approve-merge", prompt, schema: { properties: { headSha: { const: HEAD } } } }) };
}

describe("the approve-merge gate land opens from Shepherd's options", () => {
  it("marks a CI policy the reviewer judged weakened, under a seat or a visual-path rule", () => {
    const weakened = mergeWith({ ciPolicy: { kind: "weakened", keys: ["permissions"] } });

    expect(rowOfGate(weakened).row).toBe("ci-policy-weakened");
    expect(rowOfGate(weakened, VISUAL_RULE).row).toBe("ci-policy-weakened");
  });

  it("marks a malformed CI-policy line, unread changed files and malformed evidence", () => {
    expect(rowOfGate(mergeWith({ ciPolicy: { kind: "malformed" } })).row).toBe("ci-policy-malformed");
    expect(rowOfGate(mergeWith({ changedFilesUnread: "the files API failed" })).row).toBe("files-unread");
    expect(rowOfGate((): Verdict => ({ kind: "MERGE", headSha: HEAD, evidence: { head: HEAD } })).row).toBe("files-unread");
  });

  it("marks a repo skill change", () => {
    expect(rowOfGate(mergeWith({}, ["src/x.ts", ".claude/skills/x/SKILL.md"])).row).toBe("skill-path");
  });

  it("marks nothing for an unchanged CI policy, or with no MERGE at the head", () => {
    expect(rowOfGate(mergeWith({ ciPolicy: { kind: "unchanged" } })).row).toBeUndefined();
    expect(rowOfGate(() => undefined)).toEqual({ prompt: expect.not.stringContaining("\n"), row: undefined });
  });
});
