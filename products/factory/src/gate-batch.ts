import { randomUUID } from "node:crypto";
import type { GitHubPort } from "@titan-design/github";
import type { GateResolver } from "@titan-design/hitl";
import { landGate } from "./coordinator-evidence.js";
import type { BatchOutcome } from "./gate-batch-store.js";
import { itemsRefusal } from "./gate-batch-plan.js";
import { pendingGateId } from "./gate-resolve.js";
import type { FactoryHost } from "./host.js";
import { verifyProof, type KeyRing, type ProofInput, type ProofItem, type Refusal, type Statement } from "./presence-proof.js";

export interface ApplyDeps {
  /** Unix milliseconds. */
  now: () => number;
  /** This factory's hostname; a statement signed for another host is refused. */
  aud: string;
  /** Fresh PR reads; without one, only the gate store says whether a merge gate's PR moved or closed. */
  port?: Pick<GitHubPort, "getPr">;
}

interface ItemOutcome {
  gate: string;
  outcome: BatchOutcome;
  detail?: string;
}

type ApplyResult = { ok: true; batchId: string; items: ItemOutcome[] } | { ok: false; refusal: Refusal | "replayed-nonce" | "item-refused"; detail?: string };

interface Skip {
  outcome: Extract<BatchOutcome, `skipped-${string}`>;
  detail: string;
}

interface Signed {
  batchId: string;
  resolver: GateResolver;
  port?: Pick<GitHubPort, "getPr">;
}

/**
 * Applies an owner-signed proof: verifies it, refuses a nonce already used, checks every item against its live gate,
 * records the proof with every item `signed`, then fires each item that is still pending at its exact head. Nothing
 * fires unless all of that passed. The first failed resolve stops the batch; the record shows which items fired.
 */
export async function applyProof(host: FactoryHost, proof: ProofInput, keys: KeyRing, deps: ApplyDeps): Promise<ApplyResult> {
  const verified = verifyProof(proof, keys, Math.floor(deps.now() / 1000), deps.aud);
  if (!verified.ok) return verified;
  const { statement, keyId } = verified;
  if (host.batches.hasNonce(statement.nonce)) return { ok: false, refusal: "replayed-nonce" };
  const refusal = itemsRefusal(host, statement.items);
  if (refusal !== undefined) return { ok: false, refusal: "item-refused", detail: refusal };
  const batchId = randomUUID();
  if (!host.batches.open(recordOf(batchId, keyId, statement, proof), statement.items)) return { ok: false, refusal: "replayed-nonce" };
  const resolver: GateResolver = { class: "owner-terminal", id: `key:${keyId}`, channel: "factory-proof", confirmEvent: `proof:${batchId}` };
  return { ok: true, batchId, items: await fireAll(host, { batchId, resolver, port: deps.port }, statement.items) };
}

function recordOf(id: string, keyId: string, statement: Statement, proof: ProofInput) {
  const text = Buffer.from(proof.statementB64, "base64url").toString("utf8");
  return { id, keyId, nonce: statement.nonce, digest: statement.digest, statement: text, signature: proof.signatureB64, aud: statement.aud, iat: statement.iat, exp: statement.exp };
}

async function fireAll(host: FactoryHost, signed: Signed, items: readonly ProofItem[]): Promise<ItemOutcome[]> {
  const outcomes: ItemOutcome[] = items.map(({ gate }) => ({ gate, outcome: "signed" }));
  for (const [seq, item] of items.entries()) {
    const skip = await staleness(host, item, signed.port);
    const done = skip ?? fireOne(host, signed, seq, item);
    if (skip) host.batches.mark(signed.batchId, seq, skip.outcome, skip.detail);
    outcomes[seq] = { gate: item.gate, ...done };
    if (done.outcome === "failed") break;
  }
  return outcomes;
}

/** Marks the item `firing` first, so a process that dies inside the resolve leaves that item named in the record. */
function fireOne(host: FactoryHost, signed: Signed, seq: number, item: ProofItem): { outcome: BatchOutcome; detail?: string } {
  host.batches.mark(signed.batchId, seq, "firing");
  try {
    host.runtime.signal(item.runId, item.stepId, item.payload, signed.resolver);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    host.batches.mark(signed.batchId, seq, "failed", detail);
    return { outcome: "failed", detail };
  }
  host.batches.mark(signed.batchId, seq, "resolved");
  return { outcome: "resolved" };
}

/** Why the item must not fire now, read just before it would: its gate closed or moved, or a merge gate's PR did on GitHub. */
async function staleness(host: FactoryHost, item: ProofItem, port: Signed["port"]): Promise<Skip | undefined> {
  const gate = host.gates.get(item.gate);
  if (gate?.status !== "pending") return { outcome: "skipped-closed", detail: `the gate is ${gate?.status ?? "gone"}` };
  const waiting = pendingGateId(host, item.runId, item.stepId);
  if (waiting !== item.gate) return { outcome: "skipped-moved", detail: `the run waits on ${waiting ?? "no gate"} now` };
  const land = landGate(gate);
  if (land === undefined) return undefined;
  if (land.head !== item.headSha) return { outcome: "skipped-moved", detail: `the gate asks about head ${land.head}` };
  return port ? pullStaleness(port, item) : undefined;
}

async function pullStaleness(port: NonNullable<Signed["port"]>, item: ProofItem): Promise<Skip | undefined> {
  const ref = `${item.repo}#${item.pr}`;
  try {
    const pull = await port.getPr(item.repo, item.pr);
    if (pull.state !== "open") return { outcome: "skipped-closed", detail: `${ref} is ${pull.merged ? "merged" : "closed"} on GitHub` };
    if (pull.headSha !== item.headSha) return { outcome: "skipped-moved", detail: `${ref} is at head ${pull.headSha} on GitHub` };
    return undefined;
  } catch (error) {
    return { outcome: "skipped-unreadable", detail: `${ref} could not be read: ${error instanceof Error ? error.message : String(error)}` };
  }
}
