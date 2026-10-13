import type { RepoSlug } from "@titan-design/github";
import type { WorkflowRun } from "@titan-design/workflow";
import type { HeldCheck } from "./hold.js";
import { VERSION_PACKAGES_BRANCH } from "./release.js";
import { inStepOrder, payloadOf, stepName } from "./stats.js";
import { TRAIN_WORKFLOW } from "./train.js";

/** Where a trusted run waits that a batch would take: its refresh update, the CI on its refreshed head, or the train. */
export type ShadowStage = "refresh" | "refresh-ci" | "train";

export interface ShadowPeer {
  runId: string;
  pr: number;
  headSha: string;
  stage: ShadowStage;
}

export interface ShadowExcluded extends Omit<ShadowPeer, "stage"> {
  reason: "held" | "stacked" | "unread";
}

/** What the admission reads live; each read failing excludes that peer as `unread`, never admits it. */
export interface PeerReads {
  held: HeldCheck;
  baseOf: (repo: RepoSlug, pr: number) => Promise<string>;
  defaultBranch: string;
}

const FREEZE_HOLD_UPDATE = "update-branch:sh-freeze-hold:";

const isLandStep = (key: string): boolean => (stepName(key) === "ci-wait" || stepName(key) === "update-branch") && !key.startsWith(FREEZE_HOLD_UPDATE);

/** The run's ci-wait and land update-branch results, oldest first; a freeze-hold refresh is its own class and left out. */
function landReads(run: WorkflowRun): { name: string; payload: Record<string, unknown> }[] {
  return inStepOrder(run)
    .filter(({ key }) => isLandStep(key))
    .map(({ key, result }) => ({ name: stepName(key), payload: payloadOf(result) }));
}

function activeNames(run: WorkflowRun): Set<string> {
  return new Set(Object.keys(run.activeSteps).filter((key) => !key.startsWith(FREEZE_HOLD_UPDATE)).map(stepName));
}

/**
 * The stage a run waits at, read from its ledger alone. Only an approved head is ever refreshed or merged, so each
 * stage implies a trusted head. A ci-wait counts only when the update before it was a land-time refresh.
 */
export function stageOf(run: WorkflowRun): Omit<ShadowPeer, "runId" | "pr"> | undefined {
  const active = activeNames(run);
  const reads = landReads(run);
  const last = reads.at(-1);
  const head = typeof last?.payload.headSha === "string" ? last.payload.headSha : undefined;
  if (last === undefined || head === undefined) return undefined;
  if (active.has("merge") && last.name === "ci-wait") return { headSha: head, stage: "train" };
  if (active.has("update-branch") && last.name === "ci-wait" && last.payload.baseMoved === true) return { headSha: head, stage: "refresh" };
  const before = reads.at(-2);
  if (active.has("ci-wait") && last.name === "update-branch" && before?.payload.baseMoved === true) return { headSha: head, stage: "refresh-ci" };
  return undefined;
}

const prOf = (run: WorkflowRun): number | undefined => (Number(run.params.pr) > 0 ? Number(run.params.pr) : undefined);

/** A driving shepherd-pr run in `repo` other than `self`, with a PR and no release branch: the runs a batch could take. */
function candidate(run: WorkflowRun, repo: string, self: string): boolean {
  if (run.id === self || run.workflowName !== TRAIN_WORKFLOW || run.status !== "running") return false;
  return run.params.repo?.toLowerCase() === repo.toLowerCase() && run.params.branch !== VERSION_PACKAGES_BRANCH && prOf(run) !== undefined;
}

/** Why a batch would refuse this head, or undefined when it would take it. */
export async function excludedReason(reads: PeerReads, repo: RepoSlug, peer: Pick<ShadowPeer, "pr" | "headSha">): Promise<ShadowExcluded["reason"] | undefined> {
  try {
    if ((await reads.baseOf(repo, peer.pr)) !== reads.defaultBranch) return "stacked";
    return (await reads.held(repo, peer.pr, peer.headSha)) === undefined ? undefined : "held";
  } catch {
    return "unread";
  }
}

/** The peers a batch sealed now would take with `self`, and the waiting ones it would refuse, each with why. */
export async function admitPeers(runs: readonly WorkflowRun[], repo: RepoSlug, self: string, reads: PeerReads): Promise<{ peers: ShadowPeer[]; excluded: ShadowExcluded[] }> {
  const peers: ShadowPeer[] = [];
  const excluded: ShadowExcluded[] = [];
  for (const run of runs.filter((r) => candidate(r, repo, self))) {
    const stage = stageOf(run);
    const pr = prOf(run);
    if (stage === undefined || pr === undefined) continue;
    const peer = { runId: run.id, pr, ...stage };
    const reason = await excludedReason(reads, repo, peer);
    if (reason === undefined) peers.push(peer);
    else excluded.push({ runId: peer.runId, pr: peer.pr, headSha: peer.headSha, reason });
  }
  return { peers, excluded };
}
