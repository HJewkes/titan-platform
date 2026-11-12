import type { GateRecord } from "@titan-design/hitl";
import type { RepoSlug } from "@titan-design/github";
import { z } from "zod";
import type { FactoryHost, PendingGate } from "../host.js";
import { landGateHead } from "./approval-carry.js";
import { approveMergeRun, openHead } from "./head-moved.js";
import { keptForOwner } from "./owner-kept.js";
import type { ShepherdServices } from "./services.js";
import { SUPERSEDED, cancelUnlessSettled } from "./stale-gates.js";

/**
 * How `refollow` cancels a pending land gate (TP-4812): a plain supersede, so the run keeps the head's review, leaves land,
 * and asks again at the same head, where its own approval carry alone decides whether the owner's earlier merge follows.
 */
export const REFOLLOWED = `${SUPERSEDED}refollow: `;

const refollowReason = (head: string): string => `${REFOLLOWED}ask again at head ${head} so the run's approval carry decides (TP-4812)`;

/** Only the owner's own classes; a coordinator or delegate answer is never a merge the carry may follow. */
const OWNER_CLASSES: ReadonlySet<string> = new Set(["owner-terminal", "owner-remote"]);

const MergePayload = z.looseObject({ decision: z.literal("merge"), headSha: z.string() });

const APPROVE_MERGE_STEP = /^approve-merge(?::(\d+))?$/;

/** A gate id is `<runId>/<step>`. */
const stepOfGate = (gate: Pick<GateRecord, "id">): string => gate.id.slice(gate.id.indexOf("/") + 1);

interface RefollowedGate {
  runId: string;
  gateId: string;
  repo: RepoSlug;
  pr: number;
  headSha: string;
  /** False in a dry run, or when another host settled the gate first. */
  cancelled: boolean;
}

export interface RefollowReport {
  dryRun: boolean;
  gates: RefollowedGate[];
}

interface RefollowOptions {
  dryRun?: boolean;
  /** Only gates of runs on this repo; absent means every repo. */
  repo?: RepoSlug;
}

/** The run's approve-merge gates asked before `stepId`, read from the gate store by the ids the runtime gives each call. */
function earlierGates(host: FactoryHost, runId: string, stepId: string): GateRecord[] {
  const calls = Number(APPROVE_MERGE_STEP.exec(stepId)?.[1] ?? 0);
  return Array.from({ length: calls }, (_, call) => host.gates.get(`${runId}/approve-merge${call === 0 ? "" : `:${call}`}`)).filter((gate) => gate !== undefined);
}

/** An owner-class merge at the head an earlier land gate asked about; a gate cancelled unanswered is none. */
function ownerMerged(gate: GateRecord): boolean {
  const head = landGateHead(stepOfGate(gate), gate.prompt);
  const merged = MergePayload.safeParse(gate.payload).data;
  return gate.status === "resolved" && OWNER_CLASSES.has(gate.resolvedBy?.class ?? "") && head !== undefined && merged?.headSha === head;
}

/** A refollow already re-asked this head, so a carry that refused it then is not asked again and cannot loop. */
const refollowedAt = (gate: GateRecord, head: string): boolean =>
  gate.status === "cancelled" && (gate.reason ?? "").startsWith(REFOLLOWED) && landGateHead(stepOfGate(gate), gate.prompt) === head;

interface Candidate extends PendingGate {
  repo: RepoSlug;
  pr: number;
  headSha: string;
}

/** A pending land gate of a registered shepherd-pr run not kept for the owner, which holds an owner merge on an earlier land gate. */
function candidate(host: FactoryHost, services: ShepherdServices, pending: PendingGate, only: RepoSlug | undefined): Candidate | undefined {
  const head = approveMergeRun(host, pending) && landGateHead(pending.stepId, pending.gate.prompt);
  const registration = services.store.get().byRun(pending.runId);
  if (head === undefined || keptForOwner(registration) || registration?.pr == null) return undefined;
  if (only !== undefined && registration.repo.toLowerCase() !== only.toLowerCase()) return undefined;
  const earlier = earlierGates(host, pending.runId, stepOfGate(pending.gate));
  if (!earlier.some(ownerMerged) || earlier.some((gate) => refollowedAt(gate, head))) return undefined;
  return { ...pending, repo: registration.repo, pr: registration.pr, headSha: head };
}

/**
 * Cancels each pending land gate whose head is still the PR's open head, on a run not kept for the owner that holds an owner
 * merge on an earlier land gate, unless a refollow already re-asked that head. The run asks again at the same head and its
 * approval carry decides: it records the follow, or opens the owner's gate again. The coordinator supplies no answer.
 */
export async function refollowGates(host: FactoryHost, services: ShepherdServices, { dryRun = false, repo }: RefollowOptions = {}): Promise<RefollowReport> {
  const gates: RefollowedGate[] = [];
  for (const pending of host.pendingGates()) {
    const found = candidate(host, services, pending, repo);
    if (!found || (await openHead(services, pending.runId)) !== found.headSha) continue;
    // The head read yields, so a gate settled or an owner hold placed meanwhile is read again right before the cancel.
    if (host.gates.get(pending.gate.id)?.status !== "pending" || keptForOwner(services.store.get().byRun(pending.runId))) continue;
    const cancelled = !dryRun && cancelUnlessSettled(host.gates, pending.gate.id, refollowReason(found.headSha));
    if (dryRun || cancelled) gates.push({ runId: pending.runId, gateId: pending.gate.id, repo: found.repo, pr: found.pr, headSha: found.headSha, cancelled });
  }
  return { dryRun, gates };
}
