import { fakeSha } from "@titan-design/github";
import type { DispatchOptions, StepResult, WorkflowContext } from "@titan-design/workflow";
import { partialFake } from "@titan-design/test-kit";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { CiPolicyKey } from "@titan-design/session-read";
import type { PolicyRule } from "../gate-policy.js";
import { approveMergeAsk, type ApproveMergeFacts } from "../workflows/land-approval.js";
import { followingApprovals } from "./approval-carry.js";
import type { OwnMergeUpResult } from "./own-merge-up.js";
import type { RemergeResult } from "./remerge-carry.js";

const REPO = "acme/widgets";
const APPROVED = fakeSha("approved");
const LATER = fakeSha("later");
const SKILL = ".claude/skills/x/SKILL.md";
const EMPTY: RemergeResult = { carries: true, rule: "remerge-empty", headTree: "t", remergeTree: "t", paths: [], generatedPaths: [] };
const CLEAN_MERGE_UP: OwnMergeUpResult = { carries: true, rule: "own-merge-up", base: "b", headTree: "h", mergeTree: "h", prPaths: [".github/workflows/ci.yml"], mainPaths: ["src/a.ts"] };
const D21: PolicyRule = { table: "shepherd-merge-guard", rowId: "ci-policy-weakened", version: 1 };
const AUTHORITY: PolicyRule = { table: "authority", rowId: "MRG-AU", version: 1 };

const landPrompt = (head: string, rule: PolicyRule = AUTHORITY): string =>
  `Merge PR #1 in ${REPO} at head ${head}? CI is green. Policy ${rule.table}/${rule.rowId}: the policy did not allow an automated merge`;

/** The prompt land itself writes at a D21 gate: the owner-at-head marker and the card naming the weakened keys. */
const d21Prompt = (head: string, keys: CiPolicyKey[] = ["permissions"], facts: ApproveMergeFacts = {}): string =>
  approveMergeAsk(D21, { ciPolicyAt: () => ({ keys }), ...facts }, { repo: REPO, pr: 1, headSha: head, round: 0, reason: `CI-policy weakened: ${keys.join(", ")}` }).prompt;

const StepInput = z.record(z.string(), z.unknown());

interface RigOptions {
  kind?: string;
  remerge?: RemergeResult;
  own?: OwnMergeUpResult;
}

/** A run whose every later head is an empty-remerge merge-up of the approved one, and by default Shepherd's own clean merge-up too, so only the gate decides. */
function rig({ kind = "correctness", remerge = EMPTY, own = CLEAN_MERGE_UP }: RigOptions = {}) {
  const gates: string[] = [];
  const respond = (stepId: string, input: Record<string, unknown>): object => {
    if (stepId.startsWith("sh-carry-scope:")) return { kind, baseRef: "main" };
    if (stepId.startsWith("sh-remerge:")) return remerge;
    if (stepId.startsWith("sh-approval-carry:fix:")) return { carries: true, rule: "merge-up", base: "b", headTree: "h", mergeTree: "h", changedLines: 0, paths: [] };
    if (stepId.startsWith("sh-approval-carry:own:")) return own;
    return input;
  };
  async function dispatch<T extends Record<string, unknown>>(stepId: string, _template: string, options: DispatchOptions<T> = {}): Promise<StepResult<T>> {
    const input = StepInput.parse(JSON.parse(Object.values(options.vars ?? {})[0] ?? "{}"));
    return { stepId, iteration: 0, agentId: null, signal: null, completedAt: "", data: options.schema?.parse({ result: respond(stepId, input) }) };
  }
  const owner: WorkflowContext["assisted"] = async (_stepId, prompt) => {
    const head = /at head ([0-9a-f]{40})/.exec(prompt)?.[1] ?? "";
    gates.push(head);
    return { stepId: "approve-merge", iteration: 0, agentId: null, signal: null, completedAt: "", data: { decision: "merge", headSha: head } } satisfies StepResult;
  };
  const ctx = partialFake<WorkflowContext>({ runId: "run-1", dispatch });
  return { ask: followingApprovals(ctx, owner, { target: { repo: REPO, pr: 1 }, reviewedMerge: () => true }), gates };
}

describe("an owner merge approval meeting a CI-policy-weakened gate", () => {
  it("asks the owner again at a ci-policy-weakened gate, even when the head is an empty-remerge merge-up", async () => {
    const r = rig();

    await r.ask("approve-merge", landPrompt(APPROVED));
    await r.ask("approve-merge:1", landPrompt(LATER, D21));

    expect(r.gates).toEqual([APPROVED, LATER]);
  });

  it("does not follow an approval given at a ci-policy-weakened gate to a later head's gate", async () => {
    const r = rig();

    await r.ask("approve-merge", landPrompt(APPROVED, D21));
    await r.ask("approve-merge:1", landPrompt(LATER));

    expect(r.gates).toEqual([APPROVED, LATER]);
  });

  it("still follows an authority approval to an empty-remerge head without asking", async () => {
    const r = rig();

    await r.ask("approve-merge", landPrompt(APPROVED));
    const answer = await r.ask("approve-merge:1", landPrompt(LATER));

    expect(answer.data).toEqual({ decision: "merge", headSha: LATER });
    expect(r.gates).toEqual([APPROVED]);
  });
});

describe("an owner merge at a ci-policy-weakened gate following clean merge-ups (556(3))", () => {
  it("an owner merge at a ci-policy-weakened gate follows one clean merge-up to the next ci-policy-weakened gate with no new gate", async () => {
    const r = rig();

    await r.ask("approve-merge", d21Prompt(APPROVED));
    const answer = await r.ask("approve-merge:1", d21Prompt(LATER));

    expect(answer.data).toEqual({ decision: "merge", headSha: LATER });
    expect(r.gates).toEqual([APPROVED]);
  });

  it("an owner merge at a ci-policy-weakened gate follows four clean merge-ups", async () => {
    const r = rig();
    const heads = [1, 2, 3, 4].map((n) => fakeSha(`merge-up-${n}`));

    await r.ask("approve-merge", d21Prompt(APPROVED));
    for (const [round, head] of heads.entries()) await r.ask(`approve-merge:${round + 1}`, d21Prompt(head));

    expect(r.gates).toEqual([APPROVED]);
  });

  it("follows a security run's approval over Shepherd's own clean merge-up", async () => {
    const r = rig({ kind: "security" });

    await r.ask("approve-merge", d21Prompt(APPROVED));
    await r.ask("approve-merge:1", d21Prompt(LATER));

    expect(r.gates).toEqual([APPROVED]);
  });

  it("asks again when the weakened keys at the new head differ from those the owner approved", async () => {
    const r = rig();

    await r.ask("approve-merge", d21Prompt(APPROVED, ["permissions"]));
    await r.ask("approve-merge:1", d21Prompt(LATER, ["permissions", "required-check"]));

    expect(r.gates).toEqual([APPROVED, LATER]);
  });

  it("asks again when the head carries a fix commit after the merge-up", async () => {
    const r = rig({ own: { carries: false, base: "b", headTree: "h2", mergeTree: "h", reason: "tree differs from the approved head merged onto b" } });

    await r.ask("approve-merge", d21Prompt(APPROVED));
    await r.ask("approve-merge:1", d21Prompt(LATER));

    expect(r.gates).toEqual([APPROVED, LATER]);
  });

  it("asks again when the merge-up brings a carry-fenced path from main", async () => {
    const r = rig({ own: { ...CLEAN_MERGE_UP, mainPaths: ["src/a.ts", ".github/workflows/release.yml"] } });

    await r.ask("approve-merge", d21Prompt(APPROVED));
    await r.ask("approve-merge:1", d21Prompt(LATER));

    expect(r.gates).toEqual([APPROVED, LATER]);
  });

  it("asks again when the merge-up brings a repo skill path from main", async () => {
    const r = rig({ own: { ...CLEAN_MERGE_UP, mainPaths: ["src/a.ts", SKILL] } });

    await r.ask("approve-merge", d21Prompt(APPROVED));
    await r.ask("approve-merge:1", d21Prompt(LATER));

    expect(r.gates).toEqual([APPROVED, LATER]);
  });

  it.each<[string, ApproveMergeFacts]>([
    ["skill-path", { skillPathsAt: () => [SKILL] }],
    ["files-unread", { ownerAtHeadAt: () => ["files-unread"] }],
    ["ci-policy-malformed", { ownerAtHeadAt: () => ["ci-policy-malformed"] }],
  ])("asks again at a %s gate after a ci-policy-weakened approval", async (_row, facts) => {
    const r = rig();

    await r.ask("approve-merge", d21Prompt(APPROVED));
    await r.ask("approve-merge:1", d21Prompt(LATER, ["permissions"], facts));

    expect(r.gates).toEqual([APPROVED, LATER]);
  });

  it("asks again when the run's kind follows nothing", async () => {
    const r = rig({ kind: "revert" });

    await r.ask("approve-merge", d21Prompt(APPROVED));
    await r.ask("approve-merge:1", d21Prompt(LATER));

    expect(r.gates).toEqual([APPROVED, LATER]);
  });
});

describe("the approve-merge brief at a CI-policy-weakened gate", () => {
  const ask = (rule: PolicyRule) => approveMergeAsk(rule, { reviewedMerge: () => true }, { repo: REPO, pr: 1, headSha: LATER, round: 0, reason: "CI-policy weakened: permissions" });
  const recommended = (rule: PolicyRule) => ask(rule).brief.questions![0]!.options.filter((option) => option.recommended).map((option) => option.id);

  it("recommends nothing on a reviewer's MERGE and sends the owner to the card and the diff", () => {
    const { brief } = ask(D21);

    expect(recommended(D21)).toEqual([]);
    expect(brief.summary).toMatch(/The reviewer judged CI policy weakened; read the card and the diff; no recommendation\.$/);
    expect(brief.summary).not.toMatch(/recommend merge/);
  });

  it("still recommends merge on a reviewer's MERGE at an authority gate", () => {
    expect(recommended(AUTHORITY)).toEqual(["merge"]);
    expect(ask(AUTHORITY).brief.summary).toMatch(/recommend merge\.$/);
  });
});
