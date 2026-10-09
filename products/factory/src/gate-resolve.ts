import { userInfo } from "node:os";
import { isDeepStrictEqual } from "node:util";
import { matchesAllowance, type GateResolver } from "@titan-design/hitl";
import { FACTORY_ANSWER_ALLOWANCES } from "./coordinator-allowances.js";
import type { CoordinatorEvidence } from "./coordinator-evidence.js";
import { readCoordinatorEvidence, type EvidenceSources } from "./coordinator-evidence-read.js";
import type { FactoryHost } from "./host.js";
import { stepIdMatches } from "./definition.js";
import { EXIT } from "./exit-codes.js";
import { confirmOwner } from "./owner-presence.js";

interface ResolveIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: NodeJS.ProcessEnv;
}

/** Asks the owner to prove presence with `reason` shown; returns a proof id, or undefined when presence is not confirmed. */
export type OwnerPresence = (reason: string) => Promise<string | undefined>;

/**
 * `titan-factory gate resolve`: answers the gate the run waits on at `stepId`; a resolver refusal throws to the CLI, which exits 1.
 * `presence` and `sources` are injected only in code: no proof, runner, helper path or evidence is ever read from argv or the environment.
 * Without `sources` no coordinator evidence is read, so the resolve takes the presence path as before.
 */
export async function resolveGate(host: FactoryHost, io: ResolveIo, runId: string, stepId: string, json: string, presence: OwnerPresence = confirmOwner, sources?: EvidenceSources): Promise<number> {
  const payload = parsePayload(json);
  if (!payload) {
    io.stderr("error: --json must be a JSON object\n");
    return EXIT.USAGE;
  }
  const repeated = repeatedResolution(host, runId, stepId, payload);
  if (repeated !== undefined) {
    io.stdout(`already resolved ${repeated} with this answer\n`);
    return EXIT.OK;
  }
  const gateId = pendingGateId(host, runId, stepId);
  const evidenceFor = (resolver: GateResolver) => (sources && gateId ? readCoordinatorEvidence(host, sources, gateId, payload, resolver) : Promise.resolve(undefined));
  const resolution = await cliResolver(io.env, gateId, payload, presence, evidenceFor);
  if (typeof resolution === "string") {
    io.stderr(`error: ${resolution}\n`);
    return EXIT.USAGE;
  }
  const { resolver, evidence } = resolution;
  if (evidence && gateId) host.gates.resolve(gateId, payload, resolver, evidence);
  else host.runtime.signal(runId, stepId, payload, resolver);
  io.stdout(`resolved ${runId}/${stepId}${evidence ? ` as coordinator ${resolver.id} on ${evidence.kind} evidence` : ""}\n`);
  return EXIT.OK;
}

/** The gate the run waits on at `stepId` now, if any. */
export function pendingGateId(host: FactoryHost, runId: string, stepId: string): string | undefined {
  const base = `${runId}/${stepId}`;
  return host.pendingGates().find(({ gate }) => stepIdMatches(base, gate.id))?.gate.id;
}

/** The gate a repeat of this resolve already answered: none for the step is pending, and its latest gate holds this payload. */
function repeatedResolution(host: FactoryHost, runId: string, stepId: string, payload: Record<string, unknown>): string | undefined {
  const base = `${runId}/${stepId}`;
  if (host.pendingGates().some(({ gate }) => stepIdMatches(base, gate.id))) return undefined;
  let latest = host.gates.get(base);
  for (let n = 1; ; n += 1) {
    const next = host.gates.get(`${base}:${n}`);
    if (next === undefined) break;
    latest = next;
  }
  return latest?.status === "resolved" && isDeepStrictEqual(latest.payload, payload) ? latest.id : undefined;
}

interface Resolution {
  resolver: GateResolver;
  /** Set when a coordinator answers on fresh evidence; the store re-checks it and keeps it on the gate row. */
  evidence?: CoordinatorEvidence;
}

/**
 * A shell agent-chat launched (AGENT_CHAT_AGENT_ID) is owner-terminal only with a presence proof, because the owner's
 * `!` commands inherit that marker; without one it is the coordinator named by AGENT_CHAT_NAME. An answer the factory
 * allows a coordinator (a stuck-behind retry), or one fresh evidence justifies (TP-1904), skips the dialog, so it never
 * reaches the owner's screen. Any other shell stays owner-terminal without a dialog until owner question Q1 is answered.
 * CLAUDECODE is ignored: `!` commands set it too. Returns an error message when the gate's fields cannot be shown safely in the dialog.
 */
async function cliResolver(
  env: NodeJS.ProcessEnv,
  gateId: string | undefined,
  payload: Record<string, unknown>,
  presence: OwnerPresence,
  evidenceFor: (coordinator: GateResolver) => Promise<CoordinatorEvidence | undefined>,
): Promise<Resolution | string> {
  const owner: GateResolver = { class: "owner-terminal", id: userInfo().username, channel: "factory-cli" };
  if (!env.AGENT_CHAT_AGENT_ID) return { resolver: owner };
  const coordinator: GateResolver = { class: "coordinator", id: env.AGENT_CHAT_NAME || env.AGENT_CHAT_AGENT_ID, channel: "factory-cli" };
  if (gateId === undefined || matchesAllowance(FACTORY_ANSWER_ALLOWANCES, gateId, coordinator, payload)) return { resolver: coordinator };
  const evidence = await evidenceFor(coordinator);
  if (evidence !== undefined) return { resolver: coordinator, evidence };
  const reason = presenceReason(gateId, payload);
  if (reason === undefined) return `gate ${JSON.stringify(gateId)} or its decision or headSha has an unexpected shape; refusing to ask for owner presence`;
  const proof = await presence(reason);
  return { resolver: proof === undefined ? coordinator : { ...owner, confirmEvent: proof } };
}

const GATE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/;
const DECISION = /^[a-z][a-z0-9-]{0,31}$/;
const HEAD_SHA = /^[0-9a-f]{40}$/;
const MAX_REASON = 256;

/** The dialog text, built only from fields that pass a strict shape, so nothing in it can break a line or hide text. */
export function presenceReason(gateId: string, payload: Record<string, unknown>): string | undefined {
  const decision = payload.decision ?? (typeof payload.approve === "boolean" ? (payload.approve ? "approve" : "decline") : "answer");
  const head = payload.headSha;
  if (!GATE_ID.test(gateId) || typeof decision !== "string" || !DECISION.test(decision)) return undefined;
  if (head !== undefined && (typeof head !== "string" || !HEAD_SHA.test(head))) return undefined;
  const reason = `resolve gate ${gateId}: ${decision}${head === undefined ? "" : ` at ${head}`}`;
  return reason.length <= MAX_REASON ? reason : undefined;
}

export function parsePayload(json: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(json);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

