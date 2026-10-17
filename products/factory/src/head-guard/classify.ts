/** The head-guard classifier: pure decisions over answers the caller already fetched. It reads no network, clock or store. */

/** A read the pool could not serve; it counts no try and moves nothing. */
interface Unavailable {
  kind: "unavailable";
  resetAt?: string;
}

/** How the read head relates to a base head, from the compare status. */
type Ancestry = "ahead" | "behind" | "identical" | "diverged" | "missing";

export interface StoredHead {
  head: string;
  epoch: number;
  /** Heads of this PR confirmed before `head`. */
  earlierConfirmed: readonly string[];
}

/** A head the factory itself just pushed; reads older than it are stale until `expiresAt`. */
interface OwnWriteFloor {
  sha: string;
  expiresAt: number;
  /** How the read head relates to `sha`: `ahead` is a descendant, `behind` an ancestor. */
  readVsFloor: Ancestry | Unavailable;
}

export interface HeadReadInput {
  /** Undefined when this PR has no stored row yet. */
  stored: StoredHead | undefined;
  read: string;
  /** The read head relative to `stored.head`; not needed without a stored row. */
  ancestry?: Ancestry | Unavailable;
  /** The `ls-remote` pull head: a sha, null when the ref is absent, undefined when not asked for. */
  lsRemote?: string | null | Unavailable;
  floor?: OwnWriteFloor;
  now: number;
}

type ConfirmedBy = "bootstrap" | "non-ancestor" | "fast-forward" | "ls-remote";

type StaleReason =
  | "ancestor-of-stored"
  | "earlier-confirmed-head"
  | "ls-remote-disagrees"
  | "ancestry-missing"
  | "below-own-write";

export type HeadClass =
  | { kind: "same" }
  | { kind: "confirmed"; by: ConfirmedBy }
  | { kind: "suspect"; needs: "second-read" | "ls-remote" }
  | { kind: "stale"; reason: StaleReason }
  | Unavailable;

const isUnavailable = (value: string | Unavailable | null): value is Unavailable =>
  typeof value === "object" && value !== null;

/** Only a `confirmed` outcome may advance the head epoch. */
export const advances = (outcome: HeadClass): outcome is Extract<HeadClass, { kind: "confirmed" }> =>
  outcome.kind === "confirmed";

function belowFloor(floor: OwnWriteFloor | undefined, read: string, now: number): boolean {
  if (floor === undefined || now >= floor.expiresAt || read === floor.sha) return false;
  return floor.readVsFloor !== "ahead";
}

function settleSuspect(read: string, lsRemote: HeadReadInput["lsRemote"], ask: "second-read" | "ls-remote", by: ConfirmedBy, whenAtStored: StaleReason): HeadClass {
  if (lsRemote === undefined) return { kind: "suspect", needs: ask };
  if (isUnavailable(lsRemote)) return lsRemote;
  if (lsRemote === read) return { kind: "confirmed", by };
  return { kind: "stale", reason: whenAtStored };
}

function classifyStored(stored: StoredHead, input: HeadReadInput): HeadClass {
  const { read, ancestry, lsRemote } = input;
  if (ancestry === undefined) return { kind: "suspect", needs: "ls-remote" };
  if (isUnavailable(ancestry)) return ancestry;
  if (ancestry === "missing") return { kind: "stale", reason: "ancestry-missing" };
  if (ancestry === "identical") return { kind: "same" };
  if (ancestry === "ahead") return { kind: "confirmed", by: "fast-forward" };
  const earlier = stored.earlierConfirmed.includes(read);
  if (ancestry === "diverged" && !earlier) return { kind: "confirmed", by: "non-ancestor" };
  const reason: StaleReason = earlier ? "earlier-confirmed-head" : "ancestor-of-stored";
  const agrees = lsRemote === stored.head ? reason : "ls-remote-disagrees";
  return settleSuspect(read, lsRemote, "ls-remote", "ls-remote", agrees);
}

export function classifyHeadRead(input: HeadReadInput): HeadClass {
  const { stored, read, floor, now } = input;
  if (floor !== undefined && isUnavailable(floor.readVsFloor) && now < floor.expiresAt && read !== floor.sha) {
    return floor.readVsFloor;
  }
  if (belowFloor(floor, read, now)) return { kind: "stale", reason: "below-own-write" };
  if (stored === undefined) return settleSuspect(read, input.lsRemote, "second-read", "bootstrap", "ls-remote-disagrees");
  if (read === stored.head) return { kind: "same" };
  return classifyStored(stored, input);
}

/** A main sha equal to an earlier expected main or lander result is a replica showing the past. */
export function staleMain(read: string, expectedMains: readonly string[], landerResults: readonly string[]): boolean {
  return expectedMains.includes(read) || landerResults.includes(read);
}

/** What a read answered after the factory's own write. */
type AfterWriteAnswer =
  | { kind: "http"; status: number }
  | { kind: "merged"; merged: boolean }
  | { kind: "commit"; found: boolean };

/** After the factory's own write, a 404, `merged: false` or a missing commit means the replica has not caught up. */
export function staleAfterWrite(answer: AfterWriteAnswer): boolean {
  switch (answer.kind) {
    case "http":
      return answer.status === 404;
    case "merged":
      return !answer.merged;
    case "commit":
      return !answer.found;
  }
}
