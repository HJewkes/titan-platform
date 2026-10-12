import type { RepoSlug } from "@titan-design/github";
import type { OwnerBrief } from "@titan-design/review-panel";
import type { WorkflowContext } from "@titan-design/workflow";
import { approveMergeDecision, ownerBriefLines, skillChangeNote } from "../gate-brief.js";
import type { PolicyRule } from "../gate-policy.js";
import type { FailingCheck } from "./land-ci.js";

/** The one head an approval answer may cover; land asks again at any other head. */
export interface ApprovalQuestion {
  repo: RepoSlug;
  pr: number;
  headSha: string;
  round: number;
  /** The merge policy's reason for asking. */
  reason: string;
  /** The base the merge lands in, as the green read that asks saw it. */
  base?: string;
}

/** `merge` approves only the head asked about; `failed` names why a check outside CI found that head red. */
export type ApprovalAnswer = "merge" | "abandon" | { failed: string };

/**
 * Replaces the approve-merge gate. It runs on every replay, so it must record its answer (a gate or a step) rather
 * than ask afresh, and that record must name the head so an answer can never be read as covering another one.
 */
export type AskApproval = (ctx: WorkflowContext, question: ApprovalQuestion) => Promise<ApprovalAnswer>;

/** What the approve-merge gate shows beside the policy's reason, each read at the head it asks about. */
export interface ApproveMergeFacts {
  reviewedMerge?: (headSha: string) => boolean;
  ownerBriefAt?: (headSha: string) => OwnerBrief | undefined;
  /** Repo skill paths the PR changes at this head; any one drops the merge recommendation and links the diff. */
  skillPathsAt?: (headSha: string) => readonly string[];
}

/** The approve-merge gate's prompt, answer schema and brief at the head `question` names, each fact read at that head. */
export function approveMergeAsk(rule: PolicyRule, facts: ApproveMergeFacts, { repo, pr, headSha, reason, base }: ApprovalQuestion) {
  const ownerBrief = facts.ownerBriefAt?.(headSha);
  const skillPaths = facts.skillPathsAt?.(headSha) ?? [];
  const { schema, brief } = approveMergeDecision({ repo, pr, headSha, reason, reviewedMerge: facts.reviewedMerge?.(headSha) ?? false, ownerBrief, skillPaths });
  const asked = `Merge PR #${pr} in ${repo} at head ${headSha}${base ? ` into ${base}` : ""}? CI is green. Policy ${rule.table}/${rule.rowId}: ${reason}`;
  const skillLines = skillPaths.length > 0 ? ["", skillChangeNote(repo, pr, skillPaths)] : [];
  const briefLines = ownerBrief ? ["", "Reviewer's owner brief:", ...ownerBriefLines(ownerBrief)] : [];
  return { prompt: [asked, ...skillLines, ...briefLines].join("\n"), schema, brief };
}

/** The default question: the owner's approve-merge gate, whose payload must name the head shown. */
export function approveMergeGate(rule: PolicyRule, facts: ApproveMergeFacts = {}): AskApproval {
  return async (ctx, question) => {
    const { prompt, schema, brief } = approveMergeAsk(rule, facts, question);
    const answer = schema.safeParse((await ctx.assisted("approve-merge", prompt, { schema, brief })).data);
    if (!answer.success) throw new Error(`approve-merge answer does not approve head ${question.headSha}: ${answer.error.message}`);
    return answer.data.decision;
  };
}

export const DEVICE_CHECK = "device-check";

type ApprovalStop =
  | { kind: "ci-failed"; headSha: string; failing: FailingCheck[] }
  | { kind: "stopped"; reason: "abandoned"; headSha: string; detail: string };

/** Calls `trustHead` only on `merge`; land then merges that head, or asks again if a different head turns up first. */
export async function askedApproval(ctx: WorkflowContext, ask: AskApproval, question: ApprovalQuestion, trustHead: () => void): Promise<ApprovalStop | undefined> {
  const answer = await ask(ctx, question);
  const { headSha } = question;
  if (answer === "merge") return void trustHead();
  if (answer === "abandon") return { kind: "stopped", reason: "abandoned", headSha, detail: "a human declined the merge" };
  if (typeof answer?.failed === "string") return { kind: "ci-failed", headSha, failing: [deviceCheck(question, answer.failed)] };
  throw new Error(`askApproval answered ${JSON.stringify(answer)} for head ${headSha}; expected merge, abandon or { failed }`);
}

/**
 * A null run id keeps `rerunsFirst` from re-running CI over a check only a human can repeat. The note rides in
 * `conclusion` because that is the field the ci-failed prompt shows beside the check's name.
 */
function deviceCheck(question: ApprovalQuestion, note: string): FailingCheck {
  return { name: DEVICE_CHECK, conclusion: note, url: `https://github.com/${question.repo}/pull/${question.pr}`, workflowRunId: null };
}
