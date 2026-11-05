import { randomBytes, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { GateResolver } from "@titan-design/hitl";
import type { GateBatchStore } from "./gate-batch-store.js";
import { holdItemId } from "./hold-release-proof.js";
import { loadOwnerKeys } from "./owner-keys.js";
import { ownerKeyId, signStatement } from "./owner-presence.js";
import { holdDigest, verifyHoldRelease, type HoldReleaseItem, type ProofInput } from "./presence-proof.js";

/** The channel `shepherd owner-release` stamps on its resolver; a confirmEvent on it must name a hold-release record. */
const CLI_CHANNEL = "factory-cli";
const RECORD_PREFIX = "gate-batch:";
/** Under the verifier's 300 s cap; covers the helper's 120 s dialog timeout. */
const WINDOW_S = 240;

/** The owner-asked hold one release lifts: its run and PR, the head the owner releases at, and the hold as it stands now. */
export interface OwnerHeldAt {
  runId: string;
  repo: string;
  pr: number;
  head: string;
  ownerHold: { reason: string; at: string };
}

type BatchRecord = NonNullable<ReturnType<GateBatchStore["get"]>>;
type Minted = { confirmEvent: string } | { refusal: string };

const itemOf = ({ runId, repo, pr, head, ownerHold }: OwnerHeldAt): HoldReleaseItem => ({ runId, repo, pr, holdDigest: holdDigest(ownerHold.reason), holdSince: ownerHold.at, headSha: head });

/**
 * Asks the owner to sign a `titan-factory.hold-release` statement for exactly this owner-asked hold at this head (one
 * Touch ID dialog showing `reason`), verifies it against the root-owned key ring, and records it in the gate batch
 * ledger with its one item `signed`. The confirmEvent names that record, which `holdReleaseRefusal` admits once.
 */
export async function mintHoldReleaseRecord(batches: GateBatchStore, held: OwnerHeldAt, reason: string, now: () => number = Date.now): Promise<Minted> {
  const keyId = await ownerKeyId();
  if (keyId === undefined) return { refusal: "no owner signing key could be read from the presence helper" };
  const iat = Math.floor(now() / 1000);
  const item = itemOf(held);
  const statement = { v: 1, type: "titan-factory.hold-release", aud: hostname(), keyId, nonce: randomBytes(16).toString("hex"), iat, exp: iat + WINDOW_S, items: [item] };
  const bytes = Buffer.from(JSON.stringify(statement), "utf8");
  const signature = await signStatement(bytes, reason);
  if (signature === undefined) return { refusal: "owner presence was not confirmed" };
  const refusal = proofRefusal({ statementB64: bytes.toString("base64url"), signatureB64: signature }, held, now);
  if (refusal !== undefined) return { refusal };
  const batchId = randomUUID();
  const record = { id: batchId, keyId, nonce: statement.nonce, digest: item.holdDigest, statement: bytes.toString("utf8"), signature, aud: statement.aud, iat, exp: statement.exp };
  const opened = batches.open(record, [{ gate: holdItemId(held.runId), repo: held.repo, pr: held.pr, headSha: held.head }]);
  return opened ? { confirmEvent: `${RECORD_PREFIX}${batchId}` } : { refusal: "the hold-release statement's nonce was already used" };
}

/** Why a signed hold-release statement does not prove the owner released `held` now: a key outside the owner's ring, or another run, head or hold. */
function proofRefusal(proof: ProofInput, held: OwnerHeldAt, now: () => number): string | undefined {
  const keys = loadOwnerKeys();
  if (!keys.ok) return `owner keys are not installed: ${keys.refusal}`;
  const verified = verifyHoldRelease(proof, keys.ring, Math.floor(now() / 1000), hostname());
  if (!verified.ok) return `the hold-release statement was refused: ${verified.refusal}`;
  return bindingRefusal(verified.statement.items[0], held);
}

function bindingRefusal(item: HoldReleaseItem, held: OwnerHeldAt): string | undefined {
  if (item.runId !== held.runId || item.repo.toLowerCase() !== held.repo.toLowerCase() || item.pr !== held.pr) return `it was signed for ${item.repo}#${item.pr} (run ${item.runId})`;
  if (item.headSha !== held.head) return `it was signed for head ${item.headSha}`;
  if (item.holdDigest !== holdDigest(held.ownerHold.reason) || item.holdSince !== held.ownerHold.at) return "it was signed for another owner-asked hold";
  return undefined;
}

const recordFor = (batches: GateBatchStore, event: string): BatchRecord | undefined => (event.startsWith(RECORD_PREFIX) ? batches.get(event.slice(RECORD_PREFIX.length)) : undefined);

function recordRefusal(record: BatchRecord, held: OwnerHeldAt, now: () => number): string | undefined {
  const [item, ...rest] = record.items;
  if (item === undefined || rest.length > 0 || item.gate !== holdItemId(held.runId)) return `it was not signed for run ${held.runId} alone`;
  if (item.outcome !== "signed") return `it was already used (${item.outcome})`;
  return proofRefusal({ statementB64: Buffer.from(record.statement, "utf8").toString("base64url"), signatureB64: record.signature }, held, now);
}

/**
 * Why an owner-release resolver's confirmEvent does not prove the owner released `held`: it names no ledger record, the
 * record is for another run, head or hold or already spent, or its stored signature does not verify against the owner's
 * keys. A resolver on another channel, or with no confirmEvent, is not this check's to judge.
 */
export function holdReleaseRefusal(batches: GateBatchStore, held: OwnerHeldAt, resolver: Readonly<GateResolver>, now: () => number = Date.now): string | undefined {
  const event = resolver.confirmEvent;
  if (resolver.channel !== CLI_CHANNEL || event === undefined) return undefined;
  const record = recordFor(batches, event);
  if (record === undefined) return `presence proof ${JSON.stringify(event)} names no owner-signed record`;
  const refusal = recordRefusal(record, held, now);
  return refusal === undefined ? undefined : `presence proof ${JSON.stringify(event)} is refused: ${refusal}`;
}

/** Spends the record `holdReleaseRefusal` admitted, whether or not the release then landed, so a proof is never reused. */
export function spendHoldRelease(batches: GateBatchStore, resolver: Readonly<GateResolver>, released: boolean): void {
  const event = resolver.confirmEvent;
  if (resolver.channel !== CLI_CHANNEL || event === undefined || !event.startsWith(RECORD_PREFIX)) return;
  batches.mark(event.slice(RECORD_PREFIX.length), 0, released ? "resolved" : "failed", released ? undefined : "the owner-asked hold was lifted meanwhile");
}
