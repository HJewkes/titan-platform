import { createHash, randomUUID } from "node:crypto";
import type { GateBatchStore } from "../gate-batch-store.js";
import { verifiedPresence } from "../gate-resolve-presence.js";
import type { ProofInput } from "../presence-proof.js";
import type { GateAction } from "./record.js";

type Spent = { batchId: string } | { refusal: string };

/** The answer an owner-at-head tap's presence statement must name: the merge, its head and the digest of the card shown. */
const tapAnswer = ({ decision, headSha, evidenceDigest }: GateAction): Record<string, string> => ({ decision, headSha, evidenceDigest: evidenceDigest ?? "" });

/**
 * TP-4491: the evidence digest proves only that the card is unchanged, and any agent can read it, so an owner-at-head tap
 * also carries a `titan-factory.gate-presence` statement the owner's key signed over this gate and this exact answer. It is
 * verified against the root-owned key ring and spent once in the gate batch ledger, as `gate resolve`'s proof is; the
 * record's bytes and the OS account never stand in for the owner. The item reads `firing` at once, so the CLI channel,
 * which admits only `signed` items, can never take the same record.
 */
export function spendTapPresence(batches: GateBatchStore, action: GateAction, proof: ProofInput, now: () => number = Date.now): Spent {
  const presence = verifiedPresence(proof, action.gateId, now, tapAnswer(action));
  if ("refusal" in presence) return presence;
  const { statement, keyId } = presence;
  const text = Buffer.from(proof.statementB64, "base64url").toString("utf8");
  const batchId = randomUUID();
  const digest = createHash("sha256").update(text, "utf8").digest("hex");
  const record = { id: batchId, keyId, nonce: statement.nonce, digest, statement: text, signature: proof.signatureB64, aud: statement.aud, iat: statement.iat, exp: statement.exp };
  if (!batches.open(record, [{ gate: action.gateId, repo: action.repo, pr: action.pr, headSha: action.headSha }])) return { refusal: "the presence statement's nonce was already used" };
  batches.mark(batchId, 0, "firing");
  return { batchId };
}
