import type { WorkflowRun } from "@titan-design/workflow";
import type { FactoryHost, PendingGate } from "../host.js";
import { RESYNC_CONCURRENCY, RESYNC_READ_TIMEOUT_MS, mapBounded, readValue } from "./bounded.js";
import { SHEPHERD_WORKFLOW, type ShepherdServices } from "./services.js";
import { headRegressionObserver } from "../head-guard/head-regression.js";
import { lastReadHead } from "./last-read-head.js";
import { SHEPHERD_POLICY_TABLE } from "./policy.js";
import type { Escalation } from "./route-table.js";
import { SUPERSEDED, cancelUnlessSettled, gateHead } from "./stale-gates.js";
import { readPath } from "../narrow.js";
import { z } from "zod";

const MERGE_GUARD_TABLE = "shepherd-merge-guard";
const ROUTE_TABLE = "shepherd-route";
const RELEASE_TABLE = "shepherd-release";
const FAILED_ROUNDS: Escalation = "failed-rounds";
const CONFLICT: Escalation = "conflict";
const ROUTE_GATE = new RegExp(`Policy ${ROUTE_TABLE}/([a-z-]+):`);
const APPROVE_MERGE_GATE = /\/approve-merge(:\d+)?$/;
const WAITS_FOR_NEW_HEAD = new Map([
  ["sh-sent-back", /\/sh-sent-back(:\d+)?$/],
  ["ci-failed", /\/ci-failed(:\d+)?$/],
  ["sh-visual-accept", /\/sh-visual-accept(:\d+)?$/],
]);
const STUCK_BEHIND_GATE = /\/stuck-behind(:\d+)?$/;

export interface SupersededGate {
  runId: string;
  gateId: string;
  from: string;
  to: string;
  /** Why the gate no longer stands: its head moved, its base moved or is refused, or its MRG-AU gate failed only on a merge-tree read, or only on transient conditions a thaw among them. */
  condition: "head-moved" | "base-changed" | "merge-tree-only" | "transient-only";
}

/** The open PR's head now; undefined while it cannot be read, which also calls `onUnreadable`, and for a merged or closed PR, which the gone sweep ends. */
export async function openHead(services: ShepherdServices, runId: string, onUnreadable: () => void = () => undefined): Promise<string | undefined> {
  const registration = services.store.get().byRun(runId);
  if (!registration || registration.pr === null) return undefined;
  const pr = await services.port.getPr(registration.repo, registration.pr).catch(() => void onUnreadable());
  return pr?.state === "open" ? pr.headSha : undefined;
}

/**
 * The open PR's head when it moved off `asked`; undefined while it is still `asked`, cannot be read, or is merged or closed.
 * A snapshot row still at `asked` costs no PR read. Any other row is confirmed through the port, since the list may be a
 * tick stale and a stale row must not cancel a gate at the live head.
 */
export async function movedHead(services: ShepherdServices, runId: string, asked: string): Promise<string | undefined> {
  const registration = services.store.get().byRun(runId);
  if (!registration || registration.pr === null) return undefined;
  const { repo, pr: number } = registration;
  try {
    const row = (await services.snapshot?.openPrs(repo))?.find((pr) => pr.number === number);
    if (row?.headSha === asked) return undefined;
    const pr = await services.port.getPr(repo, number);
    if (pr.headSha !== asked) headRegressionObserver(services.port, services.headLog)({ repo, pr: number, held: asked, read: pr.headSha });
    return pr.state === "open" && pr.headSha !== asked ? pr.headSha : undefined;
  } catch {
    return undefined;
  }
}

const RecordedDecision = z.looseObject({
  outcome: z.string().optional(),
  headSha: z.string().optional(),
  reason: z.string().optional(),
  rule: z.looseObject({ table: z.string().optional(), rowId: z.string().optional() }).optional(),
});

type RecordedDecision = z.infer<typeof RecordedDecision>;

const DECISION_STEP = /^merge-policy(?::r(\d+))?:(\d+)$/;

/** Round, then decision index within the round; land names them `merge-policy[:rN]:i`. */
function decisionOrder(stepId: string): [number, number] {
  const match = DECISION_STEP.exec(stepId);
  return match ? [Number(match[1] ?? 0), Number(match[2])] : [-1, -1];
}

function compareOrder([roundA, indexA]: [number, number], [roundB, indexB]: [number, number]): number {
  return roundA - roundB || indexA - indexB;
}

/** The last merge decision the run recorded; a result that does not parse reads as none, so its gate stays. */
function lastMergeDecision(run: WorkflowRun): RecordedDecision | undefined {
  const decisions = Object.values(run.stepResults).filter((result) => DECISION_STEP.test(result.stepId));
  const last = decisions.sort((a, b) => compareOrder(decisionOrder(a.stepId), decisionOrder(b.stepId))).at(-1);
  try {
    return last ? RecordedDecision.safeParse(readPath(JSON.parse(last.output ?? "{}"), "result")).data : undefined;
  } catch {
    return undefined;
  }
}

/** The run's last decision when it gated the very head the prompt asks about and the prompt names its rule; any other last decision reads as none. A route gate at the same head, a conflict after the decision, names another rule. */
function gatingDecision(run: WorkflowRun, prompt: string): RecordedDecision | undefined {
  const asked = gateHead(prompt);
  const decision = lastMergeDecision(run);
  const named = decision?.rule !== undefined && prompt.includes(`Policy ${decision.rule.table}/`);
  return asked !== undefined && decision?.outcome === "gate" && decision.headSha === asked && named ? decision : undefined;
}

/** The rule and reason the run itself recorded for the gate at the head the prompt asks about; none when the last decision gated another head. */
export function gatedRule(run: WorkflowRun, prompt: string): { table: string; rowId: string; reason: string } | undefined {
  const decision = gatingDecision(run, prompt);
  const rule = decision?.rule;
  if (typeof rule?.table !== "string" || typeof rule.rowId !== "string" || typeof decision?.reason !== "string") return undefined;
  return { table: rule.table, rowId: rule.rowId, reason: decision.reason };
}

/** The head a seat-policy gate asks about: the run's last decision gated that same head under the seat table. */
export function seatPolicyHead(run: WorkflowRun, prompt: string): string | undefined {
  const decision = gatingDecision(run, prompt);
  return decision?.rule?.table === SHEPHERD_POLICY_TABLE ? decision.headSha : undefined;
}

/** The head a merge-guard gate (visual path, unread files, unknown required checks, head mismatch) asks about: the run's last decision gated that head under the guard table. */
function guardGateHead(run: WorkflowRun, prompt: string): string | undefined {
  const decision = gatingDecision(run, prompt);
  return decision?.rule?.table === MERGE_GUARD_TABLE ? decision.headSha : undefined;
}

/** The head a merge-guard visual-path gate asks about, as the run recorded it: the owner decides a visual change, so a console Ship at that head answers it. */
export function visualPathHead(run: WorkflowRun, prompt: string): string | undefined {
  const decision = gatingDecision(run, prompt);
  return decision?.rule?.table === MERGE_GUARD_TABLE && decision.rule.rowId === "visual-path" ? decision.headSha : undefined;
}

/** The head a Version Packages release gate asks about, under any release row: each row is a fact about one head's preflight. */
function releaseGateHead(run: WorkflowRun, prompt: string): string | undefined {
  const decision = gatingDecision(run, prompt);
  return decision?.rule?.table === RELEASE_TABLE ? decision.headSha : undefined;
}

interface AuthorityGate {
  head: string;
  reason: string;
}

/**
 * The head a route-table approve-merge gate asks about: failed-rounds, fix-first-runaway, no-progress or conflict. The
 * run's last decision gated that head under the gate's own route row; a conflict gate records no merge decision, so its
 * prompt's head stands. Superseding only cancels: the run asks the owner again at the new head (see `clearSuperseded`).
 */
function routeGateHead(run: WorkflowRun, gate: PendingGate["gate"]): string | undefined {
  const row = ROUTE_GATE.exec(gate.prompt)?.[1];
  if (row === undefined) return undefined;
  if (row === CONFLICT) return gateHead(gate.prompt);
  const decision = gatingDecision(run, gate.prompt);
  if (decision) return decision.rule?.rowId === row ? decision.headSha : undefined;
  // Only a failed-rounds gate of a run that recorded no merge decision at all falls back to the head the gate's own schema pins.
  return row === FAILED_ROUNDS && lastMergeDecision(run) === undefined ? schemaHead(gate.schema) : undefined;
}

function schemaHead(schema: unknown): string | undefined {
  const head = readPath(schema, "properties", "headSha", "const");
  return typeof head === "string" ? head : undefined;
}

/** An authority MRG-AU gate at the head the prompt asks about, with its recorded reason; a guard, route, release or seat gate is none. */
export function authorityGate(run: WorkflowRun, prompt: string): AuthorityGate | undefined {
  const decision = gatingDecision(run, prompt);
  const mrgAu = decision?.rule?.table === "authority" && decision.rule.rowId === "MRG-AU";
  return mrgAu && decision.headSha ? { head: decision.headSha, reason: decision.reason ?? "" } : undefined;
}

/** The shepherd-pr run behind a pending approve-merge gate; any other gate or workflow is none. */
export function approveMergeRun(host: FactoryHost, { runId, stepId, gate }: PendingGate): WorkflowRun | undefined {
  const run = host.runtime.status(runId);
  if (run?.workflowName !== SHEPHERD_WORKFLOW || stepId !== "approve-merge" || !APPROVE_MERGE_GATE.test(gate.id)) return undefined;
  return run;
}

/** Gates whose every answer but abandon waits for a new head, so a head that already moved answers them; a fixer who pushed first is never held by one. */
function waitsForNewHead({ stepId, gate }: PendingGate): boolean {
  return WAITS_FOR_NEW_HEAD.get(stepId)?.test(gate.id) ?? false;
}

/** A stuck-behind prompt names only short heads; land asks it about the head it read just before. */
function stuckBehindHead(host: FactoryHost, { runId, gate }: PendingGate): string | undefined {
  if (!STUCK_BEHIND_GATE.test(gate.id)) return undefined;
  const run = host.runtime.status(runId);
  return run?.workflowName === SHEPHERD_WORKFLOW ? lastReadHead(run) : undefined;
}

/** An approve-merge gate, release gates included, is pinned to one head; a send-back, red head or stuck-behind head only ever waits for a new head. */
function supersedableHead(host: FactoryHost, pending: PendingGate): string | undefined {
  const { runId, gate } = pending;
  if (waitsForNewHead(pending)) return host.runtime.status(runId)?.workflowName === SHEPHERD_WORKFLOW ? gateHead(gate.prompt) : undefined;
  if (pending.stepId === "stuck-behind") return stuckBehindHead(host, pending);
  const run = approveMergeRun(host, pending);
  return run && (seatPolicyHead(run, gate.prompt) ?? guardGateHead(run, gate.prompt) ?? authorityGate(run, gate.prompt)?.head ?? routeGateHead(run, gate) ?? releaseGateHead(run, gate.prompt));
}

/**
 * Cancels each shepherd-pr seat-policy, merge-guard, authority MRG-AU, shepherd-release or route-table (failed-rounds, fix-first-runaway, no-progress, conflict) approve-merge gate, sh-sent-back, ci-failed, sh-visual-accept or stuck-behind gate, whose PR moved past the
 * head it asks about; the run then takes the new head. `dryRun` reports those gates and cancels none.
 */
export async function supersedeMovedGates(host: FactoryHost, services: ShepherdServices, { dryRun = false } = {}): Promise<SupersededGate[]> {
  const superseded: SupersededGate[] = [];
  const asking = host.pendingGates().flatMap((pending) => {
    const asked = supersedableHead(host, pending);
    return asked ? [{ ...pending, asked }] : [];
  });
  const heads = await mapBounded(asking, RESYNC_CONCURRENCY, ({ runId, asked }) => movedHead(services, runId, asked), { timeoutMs: RESYNC_READ_TIMEOUT_MS, timer: services.readTimer });
  for (const [index, { runId, gate, asked }] of asking.entries()) {
    const head = readValue(heads[index]!);
    if (!head || host.gates.get(gate.id)?.status !== "pending") continue;
    if (!dryRun && !cancelUnlessSettled(host.gates, gate.id, `${SUPERSEDED}the pull request moved from head ${asked} to ${head}`)) continue;
    superseded.push({ runId, gateId: gate.id, from: asked, to: head, condition: "head-moved" });
  }
  return superseded;
}
