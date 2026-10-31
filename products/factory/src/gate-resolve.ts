import { userInfo } from "node:os";
import { isDeepStrictEqual } from "node:util";
import { matchesAllowance, type GateResolver } from "@titan-design/hitl";
import { isObjectLike } from "@titan-design/rpc-protocol/narrow";
import { FACTORY_ANSWER_ALLOWANCES } from "./coordinator-allowances.js";
import type { CoordinatorEvidence } from "./coordinator-evidence.js";
import { readCoordinatorEvidence, type EvidenceSources } from "./coordinator-evidence-read.js";
import type { FactoryHost } from "./host.js";
import { stepIdMatches } from "./definition.js";
import { EXIT } from "./exit-codes.js";
import type { GateBatchStore } from "./gate-batch-store.js";
import { mintPresenceRecord } from "./gate-resolve-presence.js";
import { mintHoldReleaseRecord, type OwnerHeldAt } from "./owner-release-presence.js";

interface ResolveIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: NodeJS.ProcessEnv;
}

/**
 * `titan-factory gate resolve`: answers the gate the run waits on at `stepId`; a resolver refusal throws to the CLI, which exits 1.
 * Presence is always an owner-signed statement, and `sources` is injected only in code: no proof, runner, helper path or evidence is ever read from argv or the environment.
 * Without `sources` no coordinator evidence is read, so the resolve takes the presence path as before.
 */
export async function resolveGate(host: FactoryHost, io: ResolveIo, runId: string, stepId: string, json: string, sources?: EvidenceSources): Promise<number> {
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
  const resolution = await cliResolver(io.env, host.batches, gateId, payload, evidenceFor);
  if (typeof resolution === "string") {
    io.stderr(`error: ${resolution}\n`);
    return EXIT.USAGE;
  }
  if (resolution.presenceRefusal) io.stderr(`owner presence refused: ${resolution.presenceRefusal}\n`);
  applyResolution(host, runId, stepId, gateId, payload, resolution);
  const { resolver, evidence } = resolution;
  io.stdout(`resolved ${runId}/${stepId}${evidence ? ` as coordinator ${resolver.id} on ${evidence.kind} evidence` : ""}\n`);
  return EXIT.OK;
}

/** The store spends the presence record when it admits it; one the store refused first is spent here, so it is never reused. */
function applyResolution(host: FactoryHost, runId: string, stepId: string, gateId: string | undefined, payload: Record<string, unknown>, { resolver, evidence, presenceBatch }: Resolution): void {
  try {
    if (evidence && gateId) host.gates.resolve(gateId, payload, resolver, evidence);
    else host.runtime.signal(runId, stepId, payload, resolver);
  } catch (error) {
    if (presenceBatch && host.batches.get(presenceBatch)?.items[0]?.outcome === "signed") host.batches.mark(presenceBatch, 0, "failed", error instanceof Error ? error.message : String(error));
    throw error;
  }
}

/** The gate the run waits on at `stepId` now, if any. */
export function pendingGateId(host: FactoryHost, runId: string, stepId: string): string | undefined {
  const base = `${runId}/${stepId}`;
  return host.pendingGates().find(({ gate }) => stepIdMatches(base, gate.id))?.gate.id;
}

/** The gate a repeat of this resolve already answered: none for the step is pending, and its latest gate holds this payload. */
export function repeatedResolution(host: FactoryHost, runId: string, stepId: string, payload: Record<string, unknown>): string | undefined {
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
  /** The gate batch row the owner's signed presence was recorded in. */
  presenceBatch?: string;
  /** Why an agent shell's presence proof failed, so the resolve falls back to the coordinator the store then refuses. */
  presenceRefusal?: string;
}

/**
 * A shell agent-chat launched (AGENT_CHAT_AGENT_ID) is owner-terminal only with an owner-signed presence record for this
 * gate and answer (`mintPresenceRecord`), because the owner's
 * `!` commands inherit that marker; without one it is the coordinator named by AGENT_CHAT_NAME. An answer the factory
 * allows a coordinator (a stuck-behind retry), or one fresh evidence justifies (TP-1904), skips the dialog, so it never
 * reaches the owner's screen. Any other shell stays owner-terminal without a dialog until owner question Q1 is answered.
 * CLAUDECODE is ignored: `!` commands set it too. Returns an error message when the gate's fields cannot be shown safely in the dialog.
 */
async function cliResolver(
  env: NodeJS.ProcessEnv,
  batches: GateBatchStore,
  gateId: string | undefined,
  payload: Record<string, unknown>,
  evidenceFor: (coordinator: GateResolver) => Promise<CoordinatorEvidence | undefined>,
): Promise<Resolution | string> {
  if (!env.AGENT_CHAT_AGENT_ID) return { resolver: ownerTerminal() };
  const coordinator = coordinatorOf(env.AGENT_CHAT_NAME || env.AGENT_CHAT_AGENT_ID);
  if (gateId === undefined || matchesAllowance(FACTORY_ANSWER_ALLOWANCES, gateId, coordinator, payload)) return { resolver: coordinator };
  const evidence = await evidenceFor(coordinator);
  if (evidence !== undefined) return { resolver: coordinator, evidence };
  const reason = presenceReason(gateId, payload);
  if (reason === undefined) return `gate ${JSON.stringify(gateId)} or its decision or headSha has an unexpected shape; refusing to ask for owner presence`;
  const minted = await mintPresenceRecord(batches, gateId, payload, reason);
  if ("refusal" in minted) return { resolver: coordinator, presenceRefusal: minted.refusal };
  return { resolver: { ...ownerTerminal(), confirmEvent: minted.confirmEvent }, presenceBatch: minted.batchId };
}

const ownerTerminal = (): GateResolver => ({ class: "owner-terminal", id: userInfo().username, channel: "factory-cli" });
const coordinatorOf = (id: string): GateResolver => ({ class: "coordinator", id, channel: "factory-cli" });

/**
 * The owner-only check for `shepherd owner-release`: no allowance and no evidence admit a coordinator. A shell
 * agent-chat launched (AGENT_CHAT_AGENT_ID) is the owner only with an owner-signed hold-release record for exactly
 * `held` (`mintHoldReleaseRecord`), which `ownerRelease` verifies against the ledger; without one it is refused. Any
 * other shell is owner-terminal without a dialog, as for gates. Returns the refusal as a string.
 */
export async function ownerResolver(env: NodeJS.ProcessEnv, batches: GateBatchStore, held: OwnerHeldAt, reason: string): Promise<GateResolver | string> {
  const owner = ownerTerminal();
  if (!env.AGENT_CHAT_AGENT_ID) return owner;
  const minted = await mintHoldReleaseRecord(batches, held, reason);
  if ("refusal" in minted) return `${minted.refusal}, so ${env.AGENT_CHAT_NAME || env.AGENT_CHAT_AGENT_ID}, a shell agent-chat launched, is refused: only the owner may ${reason}`;
  return { ...owner, confirmEvent: minted.confirmEvent };
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
    return isObjectLike(value) && !Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

