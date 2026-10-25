import type { GitHubPort } from "@titan-design/github";
import { GateAlreadySettled, GateExpired, GateNotFound, GatePayloadInvalid, GateResolverRefused, type GateRecord } from "@titan-design/hitl";
import { AWAIT_NEW_HEAD, MERGE_GATE, SENT_BACK_GATE, gatePr, isSkillPathLand, landGate, pinnedHead, stepOf } from "../coordinator-evidence.js";
import { stepIdMatches } from "../definition.js";
import { batchRefusal } from "../gate-batch-plan.js";
import { WAIVE_PROOF } from "../gate-brief.js";
import { pendingGateId } from "../gate-resolve.js";
import type { FactoryHost } from "../host.js";
import { headGateAsks } from "../shepherd/stale-gates.js";
import { z } from "zod";
import { consoleResolver, githubOutcome, refused, type Outcome } from "./outcome.js";
import type { GateAction, Read } from "./record.js";

/**
 * The steps a console tap may resolve and the decisions it may give on each. Policy as data: an approve-merge gate at a pinned
 * head, the Version Packages Ship under `shepherd-release/*` included (314A), and an sh-sent-back wait (TP-3949) or fix-proof
 * waiver at one head (TP-3626), neither of which merges anything. A waiver is given only where the gate's own schema offers it,
 * which Shepherd does on a fix-proof send-back alone. Hardware, after-stages and every other step stay on the terminal; hitl's
 * rule is beneath this.
 */
const CONSOLE_STEPS: ReadonlyMap<string, readonly string[]> = new Map([
  [MERGE_GATE, Object.freeze(["merge"])],
  [SENT_BACK_GATE, Object.freeze([AWAIT_NEW_HEAD, WAIVE_PROOF])],
]);

/** A waiver's `anyOf` shape pins the head, which `pinnedHead` reads only at the top level, so its answer always names it. */
const HEAD_PINNED_DECISIONS: ReadonlySet<string> = new Set([WAIVE_PROOF]);

/** The decision enum a gate's stored JSON schema offers; a schema without one offers nothing the console may give. */
const DecisionEnum = z.object({ properties: z.object({ decision: z.object({ enum: z.array(z.string()) }) }) });

/** The PR and head a console-answerable gate asks about. */
interface GateTarget {
  repo: string;
  pr: number;
  head: string;
}

export async function resolveGate(read: Read<GateAction>, port: GitHubPort, host: FactoryHost): Promise<Outcome> {
  const { action } = read;
  const gate = host.gates.get(action.gateId);
  if (gate === undefined) return { outcome: "gone", reason: `no gate ${action.gateId}` };
  const target = gateRefusal(gate, action);
  if ("outcome" in target) return target;
  if (gate.status !== "pending") return settled(gate, read.confirmEvent, `the gate is ${gate.status}`);
  const stale = storeMoved(host, gate, target, action) ?? (await githubOutcome(port, action));
  return stale ?? resolveOnce(read, gate, host);
}

/** The record's gate must be one the console may answer, with a decision it may give, and ask about the record's PR. */
function gateRefusal(gate: GateRecord, action: GateAction): GateTarget | Outcome {
  if (!stepIdMatches(`${action.runId}/${action.stepId}`, gate.id)) return refused("record", `gate ${gate.id} is not step ${action.stepId} of run ${action.runId}`);
  const target = targetOf(gate);
  if (target === undefined) return refused("class", `${gate.id} is ${batchRefusal(gate) ?? "not on the console's step allowlist"}`);
  if (!consoleDecisions(gate).includes(action.decision)) return refused("class", `the console may not answer ${action.decision} on ${gate.id}`);
  const samePr = target.repo.toLowerCase() === action.repo.toLowerCase() && target.pr === action.pr;
  return samePr ? target : refused("mismatch", `${gate.id} asks about ${target.repo}#${target.pr}, the record names ${action.repo}#${action.pr}`);
}

function targetOf(gate: GateRecord): GateTarget | undefined {
  const step = stepOf(gate.id);
  if (!CONSOLE_STEPS.has(step)) return undefined;
  if (step === MERGE_GATE) {
    const land = landGate(gate);
    return isSkillPathLand(land) ? undefined : land;
  }
  const pr = gatePr(gate);
  const head = headGateAsks(gate);
  return pr && head ? { ...pr, head } : undefined;
}

/** The step's allowlist, narrowed to the decisions the gate's own schema offers, so the console never gives one the gate lacks. */
function consoleDecisions(gate: GateRecord): readonly string[] {
  const offered = DecisionEnum.safeParse(gate.schema).data?.properties.decision.enum ?? [];
  const allowed = CONSOLE_STEPS.get(stepOf(gate.id)) ?? [];
  return allowed.filter((decision) => offered.includes(decision));
}

/** The run waits on a newer gate for the step, or the gate itself asks about a head other than the one the owner confirmed. */
function storeMoved(host: FactoryHost, gate: GateRecord, target: GateTarget, action: GateAction): Outcome | undefined {
  const waiting = pendingGateId(host, action.runId, stepOf(gate.id));
  if (waiting !== undefined && waiting !== gate.id) return { outcome: "moved", currentHead: headOf(host, waiting) };
  return target.head === action.headSha ? undefined : { outcome: "moved", currentHead: target.head };
}

function headOf(host: FactoryHost, gateId: string): string | undefined {
  const gate = host.gates.get(gateId);
  return gate ? targetOf(gate)?.head : undefined;
}

/** A gate or decision that pins the head takes it in the answer; a sent-back wait's answer is the decision alone. */
function payloadOf(gate: GateRecord, action: GateAction): Record<string, string> {
  const pinned = pinnedHead(gate.schema) !== undefined || HEAD_PINNED_DECISIONS.has(action.decision);
  return pinned ? { decision: action.decision, headSha: action.headSha } : { decision: action.decision };
}

/** The store settles a gate once, so of two concurrent posts of one record only one resolves; the other reads back `already`. */
function resolveOnce({ action, confirmEvent }: Read<GateAction>, gate: GateRecord, host: FactoryHost): Outcome {
  try {
    host.gates.resolve(action.gateId, payloadOf(gate, action), consoleResolver(confirmEvent));
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
