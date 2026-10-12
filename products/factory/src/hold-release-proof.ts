import { randomUUID } from "node:crypto";
import type { GitHubPort, RepoSlug } from "@titan-design/github";
import type { BatchOutcome } from "./gate-batch-store.js";
import type { FactoryHost } from "./host.js";
import { holdDigest, verifyHoldRelease, type HoldReleaseItem, type HoldReleaseStatement, type KeyRing, type ProofInput, type Refusal } from "./presence-proof.js";
import type { ShepherdStore } from "./shepherd/store.js";

export interface HoldReleaseDeps {
  /** Unix milliseconds. */
  now: () => number;
  /** This factory's hostname; a statement signed for another host is refused. */
  aud: string;
  /** The live PR head the signature must still name; the run's recorded head is never trusted for this. */
  port: Pick<GitHubPort, "getPr">;
}

export type HoldReleaseRefusal = Refusal | "replayed-nonce" | "run-mismatch" | "not-held" | "hold-changed" | "head-moved" | "head-unreadable";

export type HoldReleaseOutcome =
  | { ok: true; batchId: string; runId: string; actor: string }
  | { ok: false; refusal: HoldReleaseRefusal; detail?: string; batchId?: string };

/** A release item sits in the gate batch tables beside gate items; the prefix keeps it from ever naming a real gate. */
export const holdItemId = (runId: string): string => `hold:${runId}`;

/**
 * Lifts one Shepherd hold on an owner-signed `titan-factory.hold-release` statement. Nothing is written until the
 * signature, nonce, run, held state and reason digest all pass. The proof is then recorded, which spends its nonce, and
 * the hold is released only if the PR is still at the signed head and the hold is still exactly the one signed for.
 */
export async function applyHoldRelease(host: FactoryHost, store: ShepherdStore, proof: ProofInput, keys: KeyRing, deps: HoldReleaseDeps): Promise<HoldReleaseOutcome> {
  const verified = verifyHoldRelease(proof, keys, Math.floor(deps.now() / 1000), deps.aud);
  if (!verified.ok) return verified;
  const { statement, keyId } = verified;
  const [item] = statement.items as [HoldReleaseItem];
  if (host.batches.hasNonce(statement.nonce)) return { ok: false, refusal: "replayed-nonce" };
  const stale = holdRefusal(store, item);
  if (stale !== undefined) return stale;
  const batchId = randomUUID();
  if (!host.batches.open(recordOf(batchId, keyId, statement, proof), [{ gate: holdItemId(item.runId), repo: item.repo, pr: item.pr, headSha: item.headSha }])) {
    return { ok: false, refusal: "replayed-nonce" };
  }
  const outcome = await release(store, item, `key:${keyId}`, deps.port);
  host.batches.mark(batchId, 0, outcome.mark, outcome.detail);
  return outcome.refusal === undefined ? { ok: true, batchId, runId: item.runId, actor: `key:${keyId}` } : { ok: false, refusal: outcome.refusal, detail: outcome.detail, batchId };
}

/** Why the signed item no longer names the live hold, read before anything is written. */
function holdRefusal(store: ShepherdStore, item: HoldReleaseItem): HoldReleaseOutcome | undefined {
  const registration = store.byPr(item.repo as RepoSlug, item.pr);
  if (registration?.runId !== item.runId) return { ok: false, refusal: "run-mismatch", detail: `${item.repo}#${item.pr} is registered to ${registration?.runId ?? "no run"}` };
  if (!registration.held || registration.holdReason === null) return { ok: false, refusal: "not-held" };
  if (holdDigest(registration.holdReason) !== item.holdDigest) return { ok: false, refusal: "hold-changed", detail: "the run is held under a different reason than the one signed for" };
  return undefined;
}

interface Released {
  mark: BatchOutcome;
  refusal?: HoldReleaseRefusal;
  detail?: string;
}

/** The head is read after the proof is recorded, so a head that moves during the read leaves the nonce spent, never reusable. */
async function release(store: ShepherdStore, item: HoldReleaseItem, actor: string, port: HoldReleaseDeps["port"]): Promise<Released> {
  let head: string;
  try {
    head = (await port.getPr(item.repo as RepoSlug, item.pr)).headSha;
  } catch (error) {
    const detail = `${item.repo}#${item.pr} could not be read: ${error instanceof Error ? error.message : String(error)}`;
    return { mark: "skipped-unreadable", refusal: "head-unreadable", detail };
  }
  if (head !== item.headSha) return { mark: "skipped-moved", refusal: "head-moved", detail: `${item.repo}#${item.pr} is at head ${head} on GitHub` };
  const reason = store.byRun(item.runId)?.holdReason;
  const released = reason != null && holdDigest(reason) === item.holdDigest && store.releaseIfHeld(item.runId, reason, { actor, headSha: head });
  return released ? { mark: "resolved" } : { mark: "skipped-moved", refusal: "hold-changed", detail: "the hold changed while the PR head was read" };
}

function recordOf(id: string, keyId: string, statement: HoldReleaseStatement, proof: ProofInput) {
  const text = Buffer.from(proof.statementB64, "base64url").toString("utf8");
  const [item] = statement.items as [HoldReleaseItem];
  return { id, keyId, nonce: statement.nonce, digest: item.holdDigest, statement: text, signature: proof.signatureB64, aud: statement.aud, iat: statement.iat, exp: statement.exp };
}
