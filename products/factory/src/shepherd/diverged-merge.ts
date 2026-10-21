import { RESOLVER_CLASSES } from "@titan-design/authority";
import type { GitHubPort } from "@titan-design/github";
import type { GateRecord } from "@titan-design/hitl";
import type { WorkflowRun } from "@titan-design/workflow";
import { z } from "zod";
import type { FactoryHost } from "../host.js";
import { requireBaseRequiredChecks } from "../required-checks.js";
import { checkBase, mergeOnAllowedBase } from "../workflows/land-base.js";
import { readCi } from "../workflows/land-ci.js";
import { taskIdOf } from "../workflows/land-merge-message.js";
import { landGateBase, landGateHead } from "./approval-carry.js";
import type { Registration } from "./store.js";

/** The step row a parked run gets once the sweep merged it on the owner's answer, so its timeline shows why it merged. */
export const CARRIED_MERGE_STEP = "sh-carried-merge";

const MergeAnswer = z.looseObject({ decision: z.literal("merge"), headSha: z.string() });
const OWNER_CLASSES: readonly string[] = RESOLVER_CLASSES;

export interface DivergedMerge {
  runId: string;
  gateId: string;
  headSha: string;
  mergeSha: string;
}

interface OwnerMerge {
  gate: GateRecord;
  headSha: string;
  /** The base the gate named; a gate from before the base was named reads as none. */
  base: string | undefined;
}

/** The run's newest approve-merge gate: land asks at `approve-merge`, then `approve-merge:1`, `:2` and on. */
function latestApproveMerge(host: FactoryHost, runId: string): GateRecord | undefined {
  let latest = host.gates.get(`${runId}/approve-merge`);
  for (let n = 1; latest !== undefined; n += 1) {
    const next = host.gates.get(`${runId}/approve-merge:${n}`);
    if (next === undefined) break;
    latest = next;
  }
  return latest;
}

/**
 * The owner's merge answer on the land gate a parked run was waiting on when it was answered: the newest approve-merge
 * gate, resolved by an owner class with `merge` at the head it asked about, and never read by the run, which records
 * the answer under the gate's own step key once it reads it.
 */
export function unreadOwnerMerge(host: FactoryHost, run: WorkflowRun): OwnerMerge | undefined {
  const gate = latestApproveMerge(host, run.id);
  if (gate?.status !== "resolved" || !OWNER_CLASSES.includes(gate.resolvedBy?.class ?? "")) return undefined;
  const stepKey = gate.id.slice(run.id.length + 1);
  if (run.stepResults[stepKey] !== undefined) return undefined;
  const asked = landGateHead(stepKey, gate.prompt);
  const answer = MergeAnswer.safeParse(gate.payload).data;
  if (asked === undefined || answer?.headSha !== asked) return undefined;
  return { gate, headSha: asked, base: landGateBase(gate.prompt) };
}

/**
 * The base the merge lands in when every precondition land checks before its merge holds now: CI green at the approved
 * head on the base's required checks (so not behind on a strict repo and not conflicting), and the base the default
 * branch the gate named. Undefined on any other read.
 */
async function landableBase(port: GitHubPort, known: Registration, merge: OwnerMerge): Promise<string | undefined> {
  const target = { repo: known.repo, pr: known.pr! };
  const pr = await port.getPr(target.repo, target.pr);
  const rules = await requireBaseRequiredChecks(port, target.repo, pr.baseRef);
  const ci = await readCi(port, { ...target, contexts: rules.contexts, strict: rules.strict });
  if (ci.verdict !== "green" || ci.headSha !== merge.headSha) return undefined;
  const base = await checkBase(port, { ...target, featureBase: false });
  const named = merge.base ?? base.base;
  return base.allowed && base.base === ci.baseRef && base.base === named ? base.base : undefined;
}

/**
 * Merges a replay-diverged run's PR at the head the owner approved while it was parked, as its own land would have,
 * and ends the run with a step row naming the answer. Undefined leaves the sweep to restart it as before: no unread
 * owner merge, a head that moved since, or a precondition that fails now.
 */
export async function mergeOnOwnerAnswer(host: FactoryHost, port: GitHubPort, known: Registration, run: WorkflowRun): Promise<DivergedMerge | undefined> {
  const merge = unreadOwnerMerge(host, run);
  if (merge === undefined) return undefined;
  const base = await landableBase(port, known, merge);
  if (base === undefined) return undefined;
  const target = { repo: known.repo, pr: known.pr!, sha: merge.headSha, method: known.policy.mergeMethod, taskIds: taskIdOf(known.task), base };
  const merged = await mergeOnAllowedBase(port, target);
  if (!merged.done) return undefined;
  const carried = { runId: run.id, gateId: merge.gate.id, headSha: merge.headSha, mergeSha: merged.mergeSha };
  host.runtime.cancel(run.id, `replay diverged; merged at ${merge.headSha} on the owner's answer to ${merge.gate.id}`, { abandon: true });
  host.runtime.annotate(run.id, CARRIED_MERGE_STEP, { ...carried, base, resolvedBy: merge.gate.resolvedBy });
  return carried;
}
