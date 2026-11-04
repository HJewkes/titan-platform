import { stepIdMatches } from "../definition.js";
import type { FactoryHost, PendingGate } from "../host.js";
import { addressedSeat, deadEndAddress, type DeadEndKind, type DeadEndPorts } from "./dead-end.js";
import { singleSeat } from "./exit-notice.js";
import { storedLineage } from "./registrant.js";
import { SHEPHERD_WORKFLOW, type ShepherdServices } from "./services.js";
import { cancelUnlessSettled, gateHead, readdressedReason } from "./stale-gates.js";

/** A fixer's exit with no push, word for word as `exitGate` asks it from wake-phase's exit reason; no other send-back. */
const EXIT_PROMPT = /^The [a-z-]+ wake of PR #\d+ in \S+ at head ([0-9a-f]{40}) ended: \S+ exited without pushing a new head past \1\b.*\. Await a new head or abandon\?$/s;

/** The two route rows that are dead ends; another route row, a merge guard or an authority gate never matches. */
const ROUTE_PROMPT = / Policy shepherd-route\/(fix-first-runaway|failed-rounds): /;

interface DeadEndAsk {
  kind: DeadEndKind;
  headSha: string;
}

export interface ReaddressedGate extends DeadEndAsk {
  runId: string;
  gateId: string;
  repo: string;
  pr: number;
  /** The seat the gate goes to; null keeps it the owner's, and it is not cancelled. */
  seat: string | null;
  cancelled: boolean;
}

export interface ReaddressReport {
  applied: boolean;
  gates: ReaddressedGate[];
}

/** The dead end a pending owner gate asks about: a rule-less exit sent-back or route approve-merge; any other gate is none. */
export function deadEndAsked({ stepId, gate }: Pick<PendingGate, "stepId" | "gate">): DeadEndAsk | undefined {
  if (gate.rule !== undefined) return undefined;
  if (stepIdMatches("sh-sent-back", stepId)) {
    const headSha = EXIT_PROMPT.exec(gate.prompt)?.[1];
    return headSha === undefined ? undefined : { kind: "exited-without-push", headSha };
  }
  if (!stepIdMatches("approve-merge", stepId)) return undefined;
  const kind = ROUTE_PROMPT.exec(gate.prompt)?.[1] as DeadEndKind | undefined;
  const headSha = gateHead(gate.prompt);
  return kind === undefined || headSha === undefined ? undefined : { kind, headSha };
}

/** The address step's own read, over the services the verb has: no roster wired reads as no seat, so the owner keeps the gate. */
function servicePorts(services: ShepherdServices): DeadEndPorts | undefined {
  const { roster, store, seats } = services;
  if (roster === undefined) return undefined;
  return { lineage: (target) => storedLineage(store, target), roster: () => roster.rows(), repoSeat: (repo) => singleSeat(seats(), repo) };
}

/** Each pending dead-end owner gate of a live shepherd-pr run that has not already addressed a seat at that head. */
function candidates(host: FactoryHost, services: ShepherdServices): (PendingGate & DeadEndAsk & { repo: string; pr: number })[] {
  return host.pendingGates().flatMap((pending) => {
    const asked = deadEndAsked(pending);
    const run = asked && host.runtime.status(pending.runId);
    const registration = services.store.get().byRun(pending.runId);
    if (!asked || run?.workflowName !== SHEPHERD_WORKFLOW || registration?.pr == null) return [];
    if (addressedSeat(run, asked.headSha) !== undefined) return [];
    return [{ ...pending, ...asked, repo: registration.repo, pr: registration.pr }];
  });
}

/**
 * TP-4759's one-shot migration: hitl never re-stamps a gate's rule, so each dead-end owner gate with a resolvable seat is
 * cancelled as readdressed, and its run asks the seat at the same head. Without `apply` it only reports each gate and its
 * addressee. A gate with no seat stays the owner's.
 */
export async function readdressDeadEnds(host: FactoryHost, services: ShepherdServices, { apply = false } = {}): Promise<ReaddressReport> {
  const ports = servicePorts(services);
  const gates: ReaddressedGate[] = [];
  for (const { runId, gate, kind, headSha, repo, pr } of candidates(host, services)) {
    const seat = (await deadEndAddress(ports, { repo, pr }).catch(() => undefined)) ?? null;
    const cancelled = apply && seat !== null && cancelUnlessSettled(host.gates, gate.id, readdressedReason(seat));
    gates.push({ runId, gateId: gate.id, repo, pr, kind, headSha, seat, cancelled });
  }
  return { applied: apply, gates };
}
