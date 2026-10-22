import type { GitHubPort } from "@titan-design/github";
import { GateAlreadySettled, GateExpired, GateNotFound, GatePayloadInvalid, GateResolverRefused, type GateRecord } from "@titan-design/hitl";
import { MERGE_GATE, landGate, stepOf, type LandGate } from "../coordinator-evidence.js";
import { stepIdMatches } from "../definition.js";
import { batchRefusal } from "../gate-batch-plan.js";
import { pendingGateId } from "../gate-resolve.js";
import type { FactoryHost } from "../host.js";
import { consoleResolver, githubOutcome, refused, type Outcome } from "./outcome.js";
import type { GateAction, Read } from "./record.js";

/**
 * The steps a console tap may resolve. Policy as data: an approve-merge gate at a pinned head, the Version Packages Ship under
 * `shepherd-release/*` included (314A). Hardware, after-stages and every other step stay on the terminal; hitl's rule is beneath this.
 */
const CONSOLE_STEPS: ReadonlySet<string> = Object.freeze(new Set([MERGE_GATE]));

export async function resolveGate(read: Read<GateAction>, port: GitHubPort, host: FactoryHost): Promise<Outcome> {
  const { action } = read;
  const gate = host.gates.get(action.gateId);
  if (gate === undefined) return { outcome: "gone", reason: `no gate ${action.gateId}` };
  const land = gateRefusal(gate, action);
  if ("outcome" in land) return land;
  if (gate.status !== "pending") return settled(gate, read.confirmEvent, `the gate is ${gate.status}`);
  const stale = storeMoved(host, gate, land, action) ?? (await githubOutcome(port, action));
  return stale ?? resolveOnce(read, host);
}

/** The record's gate must be one the console may answer, and ask about the record's PR. */
function gateRefusal(gate: GateRecord, action: GateAction): LandGate | Outcome {
  if (!stepIdMatches(`${action.runId}/${action.stepId}`, gate.id)) return refused("record", `gate ${gate.id} is not step ${action.stepId} of run ${action.runId}`);
  const land = CONSOLE_STEPS.has(stepOf(gate.id)) ? landGate(gate) : undefined;
  if (land === undefined) return refused("class", `${gate.id} is ${batchRefusal(gate) ?? "not on the console's approve-merge allowlist"}`);
  const samePr = land.repo.toLowerCase() === action.repo.toLowerCase() && land.pr === action.pr;
  return samePr ? land : refused("mismatch", `${gate.id} asks about ${land.repo}#${land.pr}, the record names ${action.repo}#${action.pr}`);
}

/** The run waits on a newer gate for the step, or the gate itself pins a head other than the one the owner confirmed. */
function storeMoved(host: FactoryHost, gate: GateRecord, land: LandGate, action: GateAction): Outcome | undefined {
  const waiting = pendingGateId(host, action.runId, stepOf(gate.id));
  if (waiting !== undefined && waiting !== gate.id) return { outcome: "moved", currentHead: headOf(host, waiting) };
  return land.head === action.headSha ? undefined : { outcome: "moved", currentHead: land.head };
}

function headOf(host: FactoryHost, gateId: string): string | undefined {
  const gate = host.gates.get(gateId);
  return gate ? landGate(gate)?.head : undefined;
}

/** The store settles a gate once, so of two concurrent posts of one record only one resolves; the other reads back `already`. */
function resolveOnce({ action, confirmEvent }: Read<GateAction>, host: FactoryHost): Outcome {
  try {
    host.gates.resolve(action.gateId, { decision: action.decision, headSha: action.headSha }, consoleResolver(confirmEvent));
  } catch (error) {
    if (error instanceof GateResolverRefused) return refused("resolver", error.message);
    if (error instanceof GatePayloadInvalid) return refused("payload", error.message);
    if (error instanceof GateAlreadySettled || error instanceof GateExpired || error instanceof GateNotFound) return settledNow(host, action.gateId, confirmEvent, error.message);
    throw error;
  }
  return { outcome: "resolved", gateId: action.gateId };
}

function settledNow(host: FactoryHost, gateId: string, confirmEvent: string, reason: string): Outcome {
  const gate = host.gates.get(gateId);
  return gate ? settled(gate, confirmEvent, reason) : { outcome: "gone", reason };
}

/** `already` only when this very record resolved the gate: the confirm event is the record's own sha256. */
function settled(gate: GateRecord, confirmEvent: string, reason: string): Outcome {
  const mine = gate.status === "resolved" && gate.resolvedBy?.confirmEvent === confirmEvent;
  return mine ? { outcome: "already", gateId: gate.id } : { outcome: "gone", reason };
}
