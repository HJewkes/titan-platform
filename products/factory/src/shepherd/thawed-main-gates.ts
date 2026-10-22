import { GATE_CANCELLED_SIGNAL, type StepResult, type WorkflowRun } from "@titan-design/workflow";
import { z, type ZodType } from "zod";
import type { FactoryHost } from "../host.js";
import type { FreezeStore } from "./freeze.js";
import { SHEPHERD_WORKFLOW, type ShepherdServices } from "./services.js";
import { cancelUnlessSettled } from "./stale-gates.js";

/** How a sweep's cancel of a frozen gate starts; the run reads it as the gate's answer and moves on to cleanup. */
const EPISODE_THAWED = "thawed: ";

/** The parsed answer, or undefined for the sweep's own cancel, which leaves nothing to answer; any other cancel fails the run. */
export function unlessThawed<T>(gate: string, asked: StepResult, schema: ZodType<T>): T | undefined {
  if (asked.signal !== GATE_CANCELLED_SIGNAL) return schema.parse(asked.data);
  const reason = String(asked.data?.reason);
  if (reason.startsWith(EPISODE_THAWED)) return undefined;
  throw new Error(`${gate} was cancelled: ${reason}`);
}

/** The gates whose only question is whether to release one freeze episode. */
const FROZEN_GATES: ReadonlySet<string> = new Set(["main-red-again", "main-frozen"]);

/** The steps that record which episode a frozen gate asks about. */
const EPISODE_STEPS: ReadonlySet<string> = new Set(["sh-freeze", "sh-unfreeze"]);

const stepName = (key: string): string => key.split(":")[0]!;
const gateStep = (gateId: string): string => stepName(gateId.slice(gateId.lastIndexOf("/") + 1));
const Episode = z.looseObject({ episode: z.number() });

export interface ClosedMainGate {
  runId: string;
  gateId: string;
  episode: number;
}

/** Episodes only count up per repo, so the highest one a run recorded is the one its frozen gate asks about. */
function askedEpisode(run: WorkflowRun): number | undefined {
  const episodes = Object.entries(run.stepResults).flatMap(([key, result]) => {
    const parsed = EPISODE_STEPS.has(stepName(key)) ? Episode.safeParse(result.data?.result) : undefined;
    return parsed?.success ? [parsed.data.episode] : [];
  });
  return episodes.length === 0 ? undefined : Math.max(...episodes);
}

/** An unreadable freeze store answers undefined, so the gate stays with the owner. */
function freezesOf(services: ShepherdServices): FreezeStore | undefined {
  try {
    return services.freeze?.get();
  } catch {
    return undefined;
  }
}

/**
 * Cancels each pending main-red-again or main-frozen gate whose freeze episode is no longer live: a green head, the
 * owner's word on another gate or a hand thaw already answered it. A run that recorded no episode keeps its gate. Each
 * cancel writes a gate-cancel event naming the run, so the timeline shows why the gate closed. `dryRun` cancels nothing.
 */
export function closeThawedMainGates(host: FactoryHost, services: ShepherdServices, { dryRun = false } = {}): ClosedMainGate[] {
  const freezes = freezesOf(services);
  if (!freezes) return [];
  const closed: ClosedMainGate[] = [];
  for (const { runId, gate } of host.pendingGates()) {
    const run = FROZEN_GATES.has(gateStep(gate.id)) ? host.runtime.status(runId) : undefined;
    const repo = services.store.get().byRun(runId)?.repo;
    const episode = run?.workflowName === SHEPHERD_WORKFLOW ? askedEpisode(run) : undefined;
    if (repo === undefined || episode === undefined || freezes.live(repo, episode)) continue;
    const reason = `${EPISODE_THAWED}freeze episode ${episode} on ${repo} already thawed, so the ${gateStep(gate.id)} gate has nothing left to release`;
    if (!dryRun && !cancelUnlessSettled(host.gates, gate.id, reason)) continue;
    if (!dryRun) services.store.get().recordGateCancel(runId, reason, new Date(services.now?.() ?? Date.now()).toISOString());
    closed.push({ runId, gateId: gate.id, episode });
  }
  return closed;
}
