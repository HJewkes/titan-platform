import type { AgentRow } from "@titan-design/agent-dispatch";
import type { Presence } from "./presence.js";

export interface CleanupAgent {
  name: string;
  presence: Presence;
  status: string;
}

export interface CleanupAgents {
  roster(): Promise<readonly CleanupAgent[]>;
  /** Drops any cached roster, so the next `roster()` reads the broker. */
  invalidate(): void;
  /** Never forced: a forced retire discards work the agent's worktree still holds. */
  retire(name: string): Promise<void>;
}

export type TaskState = "open" | "done" | "missing";

/** What tells an unsliced PR whether it may close its task: the task's tags and notes, and its plan's text when it has one. */
export interface TaskSlicing {
  tags: readonly string[];
  notes: string;
  plan: string | undefined;
}

export interface CleanupTasks {
  state(initiative: string, id: string): Promise<TaskState>;
  slicing(initiative: string, id: string): Promise<TaskSlicing>;
  done(initiative: string, id: string): Promise<void>;
  /** Sets a done task back to open; an open task is left as it is, so a repeated reopen writes nothing. */
  reopen(initiative: string, id: string): Promise<void>;
  /** Adds a line to the task's notes unless the notes already hold it, so a repeated cleanup adds nothing. */
  appendNote(initiative: string, id: string, line: string): Promise<void>;
}

export interface CleanupPorts {
  agents: CleanupAgents;
  tasks: CleanupTasks;
}

/** `shepherd.taskClose`: `keep` closes a registered PR's task on every merge; `last-slice-only` only on its last slice (TP-4274). */
export type TaskClose = "keep" | "last-slice-only";

/** The last thing the exited agent wrote, from its transcript; `writtenAt` is epoch milliseconds. */
export interface LastReport {
  text: string;
  writtenAt: number;
}

/** What the notice reads and writes; absent from the deps means every exit takes the owner gate. */
export interface ExitNoticePorts {
  /** The agent-chat name of the one seat that owns `repo`, or undefined when no single seat does. */
  seatFor(repo: string): string | undefined;
  /** The config's shepherd.hubSeat, told about a held run whose policy names no seat; absent when none is set. */
  hubSeat?(): string | undefined;
  /** The seat the run's lineage names (`lineageSeat`); undefined, or absent, falls back to `seatFor`. */
  lineageSeat?(target: { repo: string; pr: number }): Promise<string | undefined>;
  lastReport(target: { repo: string; pr: number; head: string }, agent: string, sessionId?: string): Promise<LastReport | undefined>;
  send(seat: string, text: string): Promise<void>;
  /** Whether `seat` holds a live session; rejects when the roster cannot be read. Absent means every seat is taken as live. */
  live?(seat: string): Promise<boolean>;
  /** The seats a notice for `repo` goes to, in order, when its seat holds no live session. */
  fallbackSeats?(repo: string): readonly FallbackSeat[];
}

/** `from` names the config key the seat came from, so a rerouted notice's record says which one it reached. */
export interface FallbackSeat {
  seat: string;
  from: string;
}

/** The PR a review is for, at the head its intent was recorded against. */
export interface QueuedTarget {
  repo: string;
  pr: number;
  head?: string;
}

/** What a review spawn tells the gate: whether its PR is the fix for its repo's red main, and which PR it is, so status can name its place. */
export interface ReviewAsk {
  fixer: boolean;
  target?: QueuedTarget;
  /** When the run's sh-review-intent step recorded the review, from the store; it orders the queue across a serve restart, which forgets `firstAsk`. */
  intentAt?: number;
}

/** How a queued review starts once admitted: `running` reads the reviewers for the gate, then `launch` starts the agent. */
export interface ReviewStart {
  running: () => Promise<readonly number[]>;
  launch: () => Promise<void>;
  /** The waiting step's signal: aborting it takes the review out of the queue, so a cancelled run never launches a reviewer. */
  signal?: AbortSignal;
}

/** One roster reading of the reviewers running: their names, or why the roster could not be read. */
export type ReviewerReading = { running: readonly string[] } | { rosterError: string };

/** The last reading beside the concurrent cap, for `shepherd status`; a failed read has no `running`, so it never stands in for 0. */
export interface ReviewSlots {
  running?: string[];
  cap: number;
  readAt: string;
  rosterError?: string;
}

export interface SpawnGate {
  /** Resolves when the spawn of `name` is admitted; throws `SpawnDeferred` when it is not. Only a review spawn passes `review`. */
  admit(name: string, runningReviews?: readonly number[], review?: ReviewAsk): void;
  /** Keeps the newest reading of the running reviewers, replacing the one before. */
  noteReviewers(reading: ReviewerReading): void;
  /** Undefined until a spawn has read the roster in this process. */
  reviewSlots(): ReviewSlots | undefined;
  /**
   * Queues a review and resolves once it has launched. It starts when it reaches the front on a trigger the gate admits on;
   * it rejects with `ReviewSuperseded` once its pull request moves past it, and with `SpawnDeferred` once it outwaits the hold.
   */
  queueReview(name: string, review: ReviewAsk, start: ReviewStart): Promise<void>;
  /** A review ended, so a slot may be free: the queue's front asks again now rather than on the next tick. */
  reviewEnded(): void;
}

/** `unknown` carries the read's own error, so a caller can still tell a broker that is down from a refusal. */
export type RosterRead<T = readonly AgentRow[]> = { kind: "known"; rows: T } | { kind: "unknown"; error: unknown };

export interface RosterReader<T = readonly AgentRow[]> {
  read(): Promise<RosterRead<T>>;
  /** The rows of a known read; an unknown read throws its error, so it is never mistaken for an empty roster. */
  rows(): Promise<T>;
  /** Drops the cached rows and any read in flight, so the next caller sees the broker after a spawn, resume or retire. */
  invalidate(): void;
}

/** The test rule each brief carries, chosen by the host serve runs on, since its reviewers and fixers run there too. */
export interface SuiteRules {
  fixer: string;
  reviewer: string;
}

export type RemoveDir = (path: string) => Promise<void>;
