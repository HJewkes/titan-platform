import { fakeSha } from "@titan-design/github";
import { snapshotBrief } from "@titan-design/hitl";
import { describe, expect, it } from "vitest";
import { approveMergeDecision } from "../gate-brief.js";
import { approveMergeAsk } from "../workflows/land-approval.js";
import type { Verdict } from "./phases.js";
import { shepherdGatePolicy, shepherdLandOptions, type EffectivePolicy } from "./policy.js";

const REPO = "octo/demo";
const HEAD = fakeSha("skill-brief-head");
const FILES_URL = `https://github.com/${REPO}/pull/7/files`;
const SKILLS = [".claude/skills/x/SKILL.md", "pkg/a/.claude/skills/y/run.sh"];
const target = { repo: REPO, pr: 7, headSha: HEAD, reason: "the owner reviews repo skill changes", reviewedMerge: true };
const OWNER_GATE: EffectivePolicy = { merge: "owner-gate", mergeMethod: "squash", fixer: false, seat: "gated-seat" };

/** A MERGE review at HEAD whose evidence read `changedPaths`; only the fields the policy reads are filled. */
const mergeAt =
  (changedPaths: string[]) =>
  (headSha: string): Verdict | undefined =>
    headSha === HEAD ? { kind: "MERGE", headSha, evidence: { head: HEAD, merge: { changedPaths }, record: {} } } : undefined;

const recommended = (decision: ReturnType<typeof approveMergeDecision>) => decision.brief.questions![0]!.options.filter((option) => option.recommended).map((option) => option.id);

describe("the approve-merge brief at a head that changes repo skills", () => {
  it("names each skill path and the pull files URL, and recommends nothing even after a reviewer MERGE", () => {
    const decision = approveMergeDecision({ ...target, skillPaths: SKILLS });

    for (const path of SKILLS) expect(decision.brief.summary).toContain(path);
    expect(decision.brief.summary).toContain(FILES_URL);
    expect(decision.brief.evidenceRef).toBe(FILES_URL);
    expect(decision.brief.questions![0]!.question).toContain(FILES_URL);
    expect(recommended(decision)).toEqual([]);
    expect(() => snapshotBrief("approve-merge", decision.brief, true)).not.toThrow();
  });

  it("keeps the files URL in the summary and question when the path list is too long to fit", () => {
    const many = Array.from({ length: 60 }, (_, i) => `.claude/skills/skill-${i}/SKILL.md`);

    const { brief } = approveMergeDecision({ ...target, skillPaths: many });

    expect(brief.summary).toContain(FILES_URL);
    expect(brief.questions![0]!.question).toContain(FILES_URL);
    expect(() => snapshotBrief("approve-merge", brief, true)).not.toThrow();
  });

  it("leaves a skill-free brief exactly as it was, merge still recommended", () => {
    const without = approveMergeDecision(target);

    const empty = approveMergeDecision({ ...target, skillPaths: [] });

    expect(empty.brief).toEqual(without.brief);
    expect(recommended(empty)).toEqual(["merge"]);
    expect(without.brief.evidenceRef).toBe(`https://github.com/${REPO}/pull/7`);
  });

  it("lists the skill paths and the files URL in the gate prompt land opens from Shepherd's options", () => {
    const options = shepherdLandOptions(() => OWNER_GATE, mergeAt(["src/x.ts", ...SKILLS]));

    const { prompt, brief } = approveMergeAsk({ table: "shepherd-seat", rowId: "gated-seat", version: 1 }, { ...options, reviewedMerge: () => true }, { repo: REPO, pr: 7, headSha: HEAD, round: 0, reason: "policy" });

    for (const path of SKILLS) expect(prompt).toContain(path);
    expect(prompt).toContain(FILES_URL);
    expect(prompt).not.toContain("src/x.ts");
    expect(brief.questions![0]!.options.some((option) => option.recommended)).toBe(false);
  });
});

describe("an owner-gate seat's gate reason", () => {
  it("lists the skill paths the MERGE evidence at that head read", () => {
    const decision = shepherdGatePolicy(OWNER_GATE, mergeAt(["src/x.ts", ...SKILLS])).decide("merge", { headSha: HEAD });

    expect(decision).toMatchObject({ outcome: "gate", rule: { table: "shepherd-seat", rowId: "gated-seat" } });
    expect(decision.reason).toContain(`; repo skill changes: ${SKILLS.join(", ")}`);
  });

  it("adds nothing for a skill-free head", () => {
    const decision = shepherdGatePolicy(OWNER_GATE, mergeAt(["src/x.ts"])).decide("merge", { headSha: HEAD });

    expect(decision.reason).toBe("seat gated-seat policy owner-gate waits for the owner on merge; review at this head: MERGE");
  });
});
