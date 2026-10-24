import { createHash, randomBytes, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { isDeepStrictEqual } from "node:util";
import type { GateAuthorize, GateRecord, GateResolver } from "@titan-design/hitl";
import type { GateBatchStore } from "./gate-batch-store.js";
import { loadOwnerKeys } from "./owner-keys.js";
import { ownerKeyId, signStatement } from "./owner-presence.js";
import { verifyGatePresence, type GatePresenceStatement, type ProofInput } from "./presence-proof.js";

/** The channel `gate resolve` stamps on its resolvers; a confirmEvent on it must name a presence record. */
export const CLI_CHANNEL = "factory-cli";
const RECORD_PREFIX = "gate-batch:";
/** Under the verifier's 300 s cap; covers the helper's 120 s dialog timeout. */
const WINDOW_S = 240;

type BatchRecord = NonNullable<ReturnType<GateBatchStore["get"]>>;
type Minted = { confirmEvent: string; batchId: string } | { refusal: string };

/**
 * Asks the owner to sign a presence statement for exactly this gate and answer (one Touch ID dialog showing `reason`),
 * verifies it against the root-owned key ring, and records it in the gate batch ledger with its one item `signed`.
 * The confirmEvent names that record; `presenceRefusal` admits it once, for this gate only. A CLI gate may name no PR,
 * so the item's repo, pr and head are blank; the signed statement holds the answer.
 */
export async function mintPresenceRecord(batches: GateBatchStore, gateId: string, payload: Record<string, unknown>, reason: string, now: () => number = Date.now): Promise<Minted> {
  const keyId = await ownerKeyId();
  if (keyId === undefined) return { refusal: "no owner signing key could be read from the presence helper" };
  const iat = Math.floor(now() / 1000);
  const item = { gate: gateId, payload: payload as GatePresenceStatement["items"][0]["payload"] };
  const statement: GatePresenceStatement = { v: 1, type: "titan-factory.gate-presence", aud: hostname(), keyId, nonce: randomBytes(16).toString("hex"), iat, exp: iat + WINDOW_S, items: [item] };
  const bytes = Buffer.from(JSON.stringify(statement), "utf8");
  const signature = await signStatement(bytes, reason);
  if (signature === undefined) return { refusal: "owner presence was not confirmed" };
  const text = bytes.toString("utf8");
  const refusal = proofRefusal({ statementB64: bytes.toString("base64url"), signatureB64: signature }, gateId, now, payload);
  if (refusal !== undefined) return { refusal };
  const batchId = randomUUID();
  const digest = createHash("sha256").update(text, "utf8").digest("hex");
  const record = { id: batchId, keyId, nonce: statement.nonce, digest, statement: text, signature, aud: statement.aud, iat, exp: statement.exp };
  const opened = batches.open(record, [{ gate: gateId, repo: "", pr: 0, headSha: "" }]);
  return opened ? { confirmEvent: `${RECORD_PREFIX}${batchId}`, batchId } : { refusal: "the presence statement's nonce was already used" };
}

/** Why a signed presence statement does not prove the owner answered `gateId` (with `payload`, when given) now. */
function proofRefusal(proof: ProofInput, gateId: string, now: () => number, payload?: Record<string, unknown>): string | undefined {
  const keys = loadOwnerKeys();
  if (!keys.ok) return `owner keys are not installed: ${keys.refusal}`;
  const verified = verifyGatePresence(proof, keys.ring, Math.floor(now() / 1000), hostname());
  if (!verified.ok) return `the presence statement was refused: ${verified.refusal}`;
  const [item] = verified.statement.items;
  if (item.gate !== gateId) return `the presence statement was signed for gate ${item.gate}`;
  if (payload !== undefined && !isDeepStrictEqual(item.payload, payload)) return "the presence statement was signed for another answer";
  return undefined;
}

/**
 * Why a `gate resolve` resolver's confirmEvent does not prove the owner's presence for `gate`: it names no ledger record,
 * the record is for another gate or already spent, or its stored signature no longer verifies against the owner's keys.
 * A resolver on another channel, or with no confirmEvent, is not this check's to judge.
 */
export function presenceRefusal(batches: GateBatchStore, gate: Readonly<GateRecord>, resolver: Readonly<GateResolver>, now: () => number = Date.now): string | undefined {
  const event = resolver.confirmEvent;
  if (resolver.channel !== CLI_CHANNEL || event === undefined) return undefined;
  const batchId = batchIdOf(event);
  const record = batchId === undefined ? undefined : batches.get(batchId);
  if (record === undefined) return `presence proof ${JSON.stringify(event)} names no owner-signed record`;
  const refusal = recordRefusal(record, gate.id, now);
  return refusal === undefined ? undefined : `presence proof ${JSON.stringify(event)} is refused: ${refusal}`;
}

const batchIdOf = (event: string): string | undefined => (event.startsWith(RECORD_PREFIX) ? event.slice(RECORD_PREFIX.length) : undefined);

function recordRefusal(record: BatchRecord, gateId: string, now: () => number): string | undefined {
  const [item, ...rest] = record.items;
  if (item === undefined || rest.length > 0 || item.gate !== gateId) return `it was not signed for gate ${gateId} alone`;
  if (item.outcome !== "signed") return `it was already used (${item.outcome})`;
  return proofRefusal({ statementB64: Buffer.from(record.statement, "utf8").toString("base64url"), signatureB64: record.signature }, gateId, now);
}

/**
 * Runs `presenceRefusal` before the store's own `authorize`, so a forged, spent or misdirected proof never resolves a gate,
 * and spends the record once both admit it. A payload or write that then fails leaves it spent: a proof is never reused.
 */
export function presenceAuthorize(batches: GateBatchStore, next: GateAuthorize, now: () => number = Date.now): GateAuthorize {
  return (gate, resolver, admission) => {
    const reason = presenceRefusal(batches, gate, resolver, now);
    if (reason !== undefined) return { allowed: false, reason };
    const decision = next(gate, resolver, admission);
    const batchId = resolver.channel === CLI_CHANNEL && resolver.confirmEvent !== undefined ? batchIdOf(resolver.confirmEvent) : undefined;
    if (decision.allowed === true && batchId !== undefined) batches.mark(batchId, 0, "resolved");
    return decision;
  };
}
