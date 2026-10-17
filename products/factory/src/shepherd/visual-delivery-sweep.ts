import type { Logger } from "@titan-design/daemon";
import { factoryStateDir, type FactoryConfig } from "../config.js";
import type { FactoryHost } from "../host.js";
import { startSweep, type Sweep } from "../sweep.js";
import { landGateHead } from "./approval-carry.js";
import type { RosterReader } from "./roster.js";
import type { GateReads, ShepherdServices, VisualDeliveryWatch } from "./services.js";
import { DEFAULT_READY_TIMEOUT_MS, deliverGate, systemDeliveryExec, type DeliveryExec, type DeliveryOutcome, type DeliveryWorld, type PrNow, type VisualDeliveryPorts } from "./visual-delivery.js";
import { defaultTitanReviewBin } from "./visual-packet-trigger.js";

const VISUAL_DELIVERY_MS = 30_000;

type Shepherd = FactoryConfig["shepherd"];
type CwdFor = (repo: string) => string | undefined;

/** `shepherd.visualDelivery`; absent or `off` wires nothing, and with no agent-chat roster no packager's exit can be seen. */
export function configuredVisualDelivery(shepherd: Shepherd, env: NodeJS.ProcessEnv, roster: RosterReader | undefined, cwdFor: CwdFor): VisualDeliveryWatch | undefined {
  const ports = deliveryPortsOf(shepherd, env, roster, cwdFor);
  return ports && visualDeliveryWatch(ports, shepherd?.visualDelivery?.everyMs ?? VISUAL_DELIVERY_MS);
}

export function deliveryPortsOf(shepherd: Shepherd, env: NodeJS.ProcessEnv, roster: RosterReader | undefined, cwdFor: CwdFor, exec?: DeliveryExec): VisualDeliveryPorts | undefined {
  const config = shepherd?.visualDelivery;
  if (!config || config.mode === "off" || !roster) return undefined;
  const titanReviewBin = shepherd.titanReviewBin ?? defaultTitanReviewBin();
  const readyTimeoutMs = config.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const run = exec ?? systemDeliveryExec(config.roundsDir);
  return { mode: config.mode, stateDir: factoryStateDir(env), titanReviewBin, console: config.console, roster, cwdFor, exec: run, now: Date.now, readyTimeoutMs };
}

export function visualDeliveryWatch(ports: VisualDeliveryPorts, everyMs: number): VisualDeliveryWatch {
  let last: DeliveryOutcome[] = [];
  return {
    everyMs,
    tick: async (gates, services, log, signal) => {
      last = await deliverPending(ports, gates, services, signal);
      for (const outcome of last.filter((each) => each.state === "refused")) log.warn({ ...outcome }, "refused a visual delivery state file");
    },
    status: () => ({
      waiting: last.filter((outcome) => outcome.state === "waiting").length,
      failed: last.filter((outcome) => outcome.state === "failed" || outcome.state === "refused").map(({ gateId, reason }) => ({ gateId, reason: reason ?? "unknown" })),
    }),
  };
}

/** One gate at a time, so two execs never write into one packet dir; the sweep itself never runs two ticks at once. */
async function deliverPending(ports: VisualDeliveryPorts, gates: GateReads, services: ShepherdServices, signal: AbortSignal): Promise<DeliveryOutcome[]> {
  const world = worldOf(gates, services);
  const outcomes: DeliveryOutcome[] = [];
  for (const { runId, stepId, gate } of gates.pendingGates()) {
    const headSha = landGateHead(stepId, gate.prompt);
    if (headSha === undefined || signal.aborted) continue;
    const outcome = await deliverGate(ports, world, { runId, gateId: gate.id, headSha, openedAt: Date.parse(gate.createdAt) }, signal);
    if (outcome) outcomes.push(outcome);
  }
  return outcomes;
}

/** GitHub's live PR, never the snapshot list: a tick-stale row must not let a moved head through to the import. */
function worldOf(gates: GateReads, services: ShepherdServices): DeliveryWorld {
  return {
    pr: async (runId): Promise<PrNow> => {
      const registration = services.store.get().byRun(runId);
      if (!registration || registration.pr === null) return "gone";
      const pr = await services.port.getPr(registration.repo, registration.pr).catch(() => undefined);
      return pr ? { repo: registration.repo, headSha: pr.headSha, open: pr.state === "open" } : "unreadable";
    },
    pending: (gateId) => gates.gate(gateId)?.status === "pending",
  };
}

/** Absent unless Shepherd runs here with `shepherd.visualDelivery` on or in shadow. */
export function startVisualDeliverySweep(host: FactoryHost, services: ShepherdServices | undefined, log: Logger): Sweep | undefined {
  const watch = services?.visualDelivery;
  if (services === undefined || watch === undefined) return undefined;
  const gates: GateReads = { pendingGates: () => host.pendingGates(), gate: (id) => host.gates.get(id) };
  return startSweep((signal) => watch.tick(gates, services, log, signal), watch.everyMs, "visual delivery sweep", log);
}

export const visualDeliveryHealth = (services: ShepherdServices | undefined): Record<string, unknown> =>
  services?.visualDelivery ? { visualDelivery: services.visualDelivery.status() } : {};
