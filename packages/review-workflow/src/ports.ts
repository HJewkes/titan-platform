import type { LineSource } from "@titan-design/evidence";
import type { PullRequest } from "@titan-design/github";
import type { Headroom, PrFacts, ReviewClock, ReviewerAgent, ReviewerDispatch, ReviewerReader, ReviewTarget } from "@titan-design/review-panel";
import type { MemberNamer } from "./types.js";

/** What preflight reads about the head in one pass. */
export interface HeadSnapshot {
  pr: PullRequest;
  /** The head's required checks, rolled up. */
  ci: "green" | "pending" | "failing";
  facts: PrFacts;
}

export interface SnapshotPort {
  read(target: ReviewTarget): Promise<HeadSnapshot>;
}

/** `line` is the raw `fix-proof/v1` line; `none` means no proof ran; `unread` means one may have and could not be read. */
export type ProofRead = { kind: "line"; line: string } | { kind: "none" } | { kind: "unread"; reason: string };

export interface ProofReaderPort {
  read(target: ReviewTarget): Promise<ProofRead>;
}

/** Whether the head is a clean merge-up of a head the review already signed off. */
export type CarryProbe = { kind: "carries"; from: string } | { kind: "no-carry" };

export interface CarryPort {
  probe(target: ReviewTarget): Promise<CarryProbe>;
}

export type CheckoutState =
  | { kind: "ready" }
  | { kind: "missing" }
  | { kind: "wrong-commit"; at: string }
  | { kind: "low-disk"; freeBytes: number; freeInodesPct: number };

/** The read-only checkout a reviewer starts in; `refresh` drops it and recreates it at the target head. */
export interface CheckoutPort {
  state(target: ReviewTarget): Promise<CheckoutState>;
  refresh(target: ReviewTarget): Promise<void>;
}

/** Fixer names are a pure function of the fingerprint, so the roster alone dedupes a fixer across PRs. */
export interface FixerPort {
  roster(): Promise<readonly ReviewerAgent[]>;
  spawn(name: string, brief: string): Promise<void>;
}

/** `account: held` means no account can start a reviewer until `resetsAt`. */
export interface HeadroomRead extends Headroom {
  account: "available" | "held";
  resetsAt?: number;
}

export interface HeadroomPort {
  read(): Promise<HeadroomRead>;
}

export interface ReviewWorkflowPorts {
  snapshot: SnapshotPort;
  proofReader: ProofReaderPort;
  carry: CarryPort;
  checkout: CheckoutPort;
  dispatch: ReviewerDispatch;
  reader: ReviewerReader;
  /** Reads cited files at the head, for the aggregate's citation check. */
  source: LineSource;
  fixer: FixerPort;
  clock: ReviewClock;
  headroom: HeadroomPort;
  /** Absent means review-panel's `memberName`. */
  namer?: MemberNamer;
}
