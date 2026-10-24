import { fakeGitHub, fakeSha, githubPort, successRun, type PrFile } from "@titan-design/github";
import type { GateRecord, GateResolver } from "@titan-design/hitl";
import type { SourceTextLocator } from "@titan-design/session-read";
import { describe, expect, it } from "vitest";
import { toJSONSchema } from "zod";
import { coordinatorEvidencePolicy, landGate } from "../coordinator-evidence.js";
import { decisionClassOf } from "../decision-class.js";
import { approveMergeDecision } from "../gate-brief.js";
import { authorityGateReason, pendingCheck } from "../test-support/authority-reason.js";
import { evidenceComment } from "./evidence-comment.js";
import { MERGE_GUARD_ROWS, decideAutoMerge, mergeEvidence, noFreezeStoreUntilTp523, type MergeEvidenceInput } from "./merge-facts.js";
import { isSkillPath } from "./skill-paths.js";

const REPO = "octo/demo";
const HEAD = fakeSha("skill-gate-head");
const REVIEWER = { agentId: "agent-rv-1", sessionId: "session-rv-1" };
const locator: SourceTextLocator = {
  source: {
    ...{ sourceId: "transcript-1", harness: "claude-code", format: "jsonl", formatVersion: null, path: "/transcripts/transcript-1.jsonl", namespace: "test" },
    ...{ conversation: { harness: "claude-code", namespace: "test", nativeId: "session-rv-1" }, provenance: { kind: "native", name: "test" } },
  },
  evidence: {
    line: { sourceId: "transcript-1", byteOffset: 0, byteLength: 1, contentHash: "0".repeat(64), lineNumber: 1, nativeOrdinal: null },
    subrecord: { index: 0, path: [] },
  },
  selector: { kind: "subrecord-text", path: ["message", "content", 0, "text"] },
};
const SKILL_FILE = ".claude/skills/x/SKILL.md";
const SKILL_RULE = { table: "shepherd-merge-guard", rowId: "skill-path", version: 1 };

const input: MergeEvidenceInput = {
  runId: "run-1",
  repo: REPO,
  pr: 1,
  head: HEAD,
  verdict: { value: "MERGE", head: HEAD, locator },
  resolver: REVIEWER,
  dispatchedReviewer: REVIEWER,
  seatGrants: ["merge-on-green-approve"],
};

/** A reviewed MERGE at HEAD with green required checks and a clean test merge; only the file list varies. */
async function evidenceFor(files: PrFile[]) {
  const fake = fakeGitHub();
  fake.addPr({ headSha: HEAD, mergeSha: fakeSha("test-merge") });
  fake.setRuns(HEAD, [successRun("validate", 1), successRun("dag-check", 2)]);
  fake.prFiles.set(1, files);
  return mergeEvidence(githubPort(fake.wire), input, noFreezeStoreUntilTp523, { kind: "correctness" });
}

const SKILL_FREE: PrFile[] = [{ path: "src/x.ts", status: "modified" }];
const WITH_SKILL: PrFile[] = [...SKILL_FREE, { path: SKILL_FILE, status: "added" }];

describe("the skill-path merge guard", () => {
  it.each([
    ["no visual paths", undefined],
    ["an empty visual path list", []],
    ["visual paths the skill file does not match", ["packages/ui/**"]],
    ["visual paths the skill file matches", ["**/*.md"]],
  ])("gates a head that adds a skill file under %s, where the same head without it allows by MRG-AU-RV", async (_case, visualPaths) => {
    const clean = await evidenceFor(SKILL_FREE);
    const skill = await evidenceFor(WITH_SKILL);

    const allowed = decideAutoMerge(HEAD, clean, visualPaths);
    const gated = decideAutoMerge(HEAD, skill, visualPaths);

    expect(allowed).toEqual({ outcome: "allow", rule: { table: "authority", rowId: "MRG-AU-RV", version: 1 }, reason: `MRG-AU-RV holds at ${HEAD}` });
    expect(gated).toEqual({ outcome: "gate", rule: SKILL_RULE, reason: `the owner reviews repo skill changes: ${SKILL_FILE}` });
  });

  it("gates a rename out of the skills directory by its previous path", async () => {
    const evidence = await evidenceFor([{ path: "docs/x.md", previousPath: SKILL_FILE, status: "renamed" }]);

    expect(decideAutoMerge(HEAD, evidence)).toMatchObject({ outcome: "gate", rule: SKILL_RULE, reason: expect.stringContaining(SKILL_FILE) });
  });

  it("still gates unread changed files first", async () => {
    const evidence = { ...(await evidenceFor(WITH_SKILL)), changedFilesUnread: "the list is truncated" };

    expect(decideAutoMerge(HEAD, evidence)).toMatchObject({ outcome: "gate", rule: { rowId: "files-unread" } });
  });

  it("records the skill gate in the evidence comment with the rule in words and the paths listed", async () => {
    const evidence = await evidenceFor(WITH_SKILL);

    const body = evidenceComment(evidence.record);

    expect(body).toContain(`**Shepherd gated** at \`${HEAD.slice(0, 7)}\`: the pull request changes repo skills`);
    expect(body).not.toContain("visual paths");
    expect(body).toContain("Rule: the pull request changes repo skills (shepherd-merge-guard/skill-path).");
    expect(body).toContain(`- \`${SKILL_FILE}\``);
  });

  it.each(MERGE_GUARD_ROWS)("names guard row %s in words and gives it a decision class", async (rowId) => {
    const { record } = await evidenceFor(SKILL_FREE);
    const decision = { outcome: "gate", rule: { table: "shepherd-merge-guard", rowId, version: 1 }, reason: "synthetic" } as const;

    const body = evidenceComment({ ...record, decision });

    expect(body).not.toContain(`Rule: shepherd-merge-guard/${rowId} (`);
    expect(decisionClassOf({ table: "shepherd-merge-guard", rowId, step: "device-confirm", prompt: "" })).toMatch(/^D\d+$/);
  });
});

describe("isSkillPath", () => {
  it.each([
    ".Claude/Skills/x",
    "pkg/a/.claude/skills/y/z.md",
    ".claude",
    ".claude/skills",
    "pkg/.claude",
    ".claude./skills/x",
    ".claude /skills/x",
    ".claude\\skills\\x",
    "./.claude/skills/x",
    ".clаude/skills/x",
    "src/ünicode.ts",
  ])("counts %s as a skill path", (path) => {
    expect(isSkillPath(path)).toBe(true);
  });

  it.each([".claude/settings.json", "docs/skills/x.md", "claude/skills/x", ".claude/agents/x.md", "src/.claudeskills/x"])("does not count %s", (path) => {
    expect(isSkillPath(path)).toBe(false);
  });
});

describe("resolving a skill-path gate", () => {
  const COORDINATOR: GateResolver = { class: "coordinator", id: "tc-synthetic", channel: "factory-cli" };
  const LIVE_REPO = "synth-org/synth-repo";
  const LIVE_PR = 41;
  const LIVE_SKILLS = [".claude/skills/synth-skill/SKILL.md", ".claude/skills/synth-skill/reference.md"];
  const SKILL_REASON = `the authority policy did not allow an automated merge: the owner reviews repo skill changes: ${LIVE_SKILLS.join(", ")}`;
  const asked = (rule: string, reason: string) => `Merge PR #${LIVE_PR} in ${LIVE_REPO} at head ${HEAD} into main? CI is green. Policy ${rule}: ${reason}`;
  /** The shape a live skill-path gate is stored in: the policy line, the skill-diff link line, then the reviewer's owner brief. */
  const livePrompt = (rule: string, reason: string) =>
    [
      asked(rule, reason),
      "",
      `Review the repo skill diff: https://github.com/${LIVE_REPO}/pull/${LIVE_PR}/files. Repo skill changes: ${LIVE_SKILLS.join(", ")}.`,
      "",
      "Reviewer's owner brief:",
      "What: Adds a synthetic skill that teaches agents a made-up workflow.",
      "Why: It changes how every agent that loads the skill behaves.",
      "Pros:",
      "- The skill is small and self-contained.",
      "Cons:",
      "- Agents follow skill text without review, so a wrong step spreads.",
      "Door: two-way",
    ].join("\n");
  const check = (id: number, name: string) => ({ id, name, conclusion: "success", headSha: HEAD });

  function gateWith(prompt: string): GateRecord {
    const { schema, brief } = approveMergeDecision({ repo: LIVE_REPO, pr: LIVE_PR, headSha: HEAD, reason: SKILL_REASON, reviewedMerge: true, skillPaths: LIVE_SKILLS });
    return {
      ...{ id: "run-1/approve-merge", prompt, schema: toJSONSchema(schema), ...brief },
      ...{ status: "pending", payload: undefined, reason: undefined, createdAt: "2026-10-12T00:00:00.000Z", resolvedAt: undefined, expiresAt: undefined },
      ...{ resolvedBy: undefined, resolvedEvidence: undefined, rule: undefined, summary: undefined, evidenceRef: undefined, questions: undefined },
    };
  }

  /** A coordinator merge on `gate`, with fresh evidence that matches the run behind it in every field. */
  function coordinatorMerge(gate: GateRecord, rule: string, reason: string): boolean {
    const evidence = {
      ...{ kind: "approve-merge", gateId: gate.id, repo: LIVE_REPO, pr: LIVE_PR, headSha: HEAD },
      ...{ run: { workflow: "shepherd-pr", repo: LIVE_REPO, pr: LIVE_PR, rule, reason, merge: "auto", visualPaths: false, held: false, frozen: false } },
      ...{ verdict: { step: `sh-await-verdict:${HEAD}`, verdict: "MERGE", head: HEAD, reviewer: "rv-synthetic" } },
      ...{ checks: { base: "main", required: ["validate", "dag-check"], runs: [check(11, "validate"), check(12, "dag-check")] } },
      ...{ pull: { state: "open", headSha: HEAD, mergeableState: "clean", mergeable: "MERGEABLE" }, readAt: "2026-10-12T18:00:00.000Z" },
    };
    return coordinatorEvidencePolicy(gate, COORDINATOR, { decision: "merge", headSha: HEAD }, evidence);
  }

  it("refuses a coordinator merge on the live-shaped multi-line prompt with its skill-diff link line, which landGate does not read as a land gate", () => {
    const gate = gateWith(livePrompt("shepherd-merge-guard/skill-path", SKILL_REASON));

    const land = landGate(gate);

    expect(land).toBeUndefined();
    expect(coordinatorMerge(gate, "shepherd-merge-guard/skill-path", SKILL_REASON)).toBe(false);
  });

  it("refuses a coordinator merge on the policy line alone, with evidence that admits the same merge on a mechanical authority gate", () => {
    const mechanicalReason = authorityGateReason(HEAD, pendingCheck(HEAD));
    const skill = gateWith(asked("shepherd-merge-guard/skill-path", SKILL_REASON));

    expect(landGate(skill)).toEqual({ repo: LIVE_REPO, pr: LIVE_PR, head: HEAD, rule: "shepherd-merge-guard/skill-path", reason: SKILL_REASON });
    expect(coordinatorMerge(gateWith(asked("authority/MRG-AU", mechanicalReason)), "authority/MRG-AU", mechanicalReason)).toBe(true);
    expect(coordinatorMerge(skill, "shepherd-merge-guard/skill-path", SKILL_REASON)).toBe(false);
  });
});
