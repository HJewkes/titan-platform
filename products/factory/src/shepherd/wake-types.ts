import type { AgentRow } from "@titan-design/agent-dispatch";
import type { PullRequest } from "@titan-design/github";
import { z } from "zod";
import { failureOf } from "./error-class.js";
import type { BumpRun } from "./bump-fixer.js";
import type { PredecessorMessage, SpawnerNotice } from "./wake-notice.js";
import type { WaitDeadlines } from "./wake-wait.js";
import type { Warmth, WarmthLimits } from "./warmth.js";
import type { TurnSince } from "./turn-check.js";

/** How the wake step reaches agent-chat. A broker that is down or a timeout is waited out; any other throw is a refusal. */
export interface ImplementerAgents {
  roster(): Promise<readonly AgentRow[]>;
  resume(name: string, message: string): Promise<void>;
  /** Delivers `message` to a live agent as one chat message, sent as the human until CC-436 adds a `shepherd` wake source. */
  message(name: string, message: string): Promise<void>;
  /** `cwd` is a checkout of the PR's repo, which the successor's own worktree is cut from. */
  spawn(name: string, brief: string, cwd: string): Promise<void>;
  /** Never forced; absent means a live agent that takes no wake is left to its seat. */
  retire?(name: string): Promise<void>;
}

export interface WakeWiring extends WaitDeadlines {
  /** Absent means agent-chat at `deps.agentChatBin`; a relative bin means none is configured, and every wake is unhandled. */
  agents?: ImplementerAgents;
  readWarmth?: (transcriptPath: string) => Promise<Warmth | undefined>;
  limits?: WarmthLimits;
  /** Defaults to reading the woken agent's transcript tail through `readWarmth`. */
  turnSince?: TurnSince;
  turnStartMs?: number;
  /** The repo's main checkout as configured, which a successor's worktree is cut from; undefined when none is bound. Defaults to the repo's seat path. */
  checkoutFor?: (repo: string) => string | undefined;
  /** The home a `~/`, `$HOME/` or `${HOME}/` checkout path expands against; defaults to the OS home. */
  home?: string;
}

export const WakeInputSchema = z.object({
  kind: z.enum(["ci-red", "review", "conflict", "fix-proof"]),
  repo: z.string().min(1),
  pr: z.number().int().positive(),
  round: z.number().int().nonnegative(),
  headSha: z.string().min(1),
  payload: z.unknown(),
  runId: z.string().min(1),
  fixFirst: z.number().int().positive().optional(),
});

export type WakeInput = z.infer<typeof WakeInputSchema>;
export type Mode = "resume" | "successor" | "live";
export type Fallback = "resume" | "message";
/**
 * The step's record: who took the wake and how, and the second ask that started its turn, for the wake analytics. A
 * `held` wake is one whose successor agent-chat refused to start, so its seat can be told before the owner is asked.
 */
export type WakeStepResult =
  | { kind: "woken"; agent: string; mode: Mode; sessionId?: string; fallback?: Fallback; askedAt?: number }
  | { kind: "unhandled"; reason: string; held?: { agent: string }; notice?: SpawnerNotice; predecessor?: PredecessorMessage };

export const unhandled = (reason: string): WakeStepResult => ({ kind: "unhandled", reason });
export const held = (agent: string, error: unknown): WakeStepResult => ({ kind: "unhandled", reason: `agent-chat refused to start the successor ${agent}: ${failureOf(error)}`, held: { agent } });

export interface WakeTask extends BumpRun {
  input: WakeInput;
  pr: PullRequest;
  reason: string;
  payload: string;
  implementer: string;
  /** Successors the store's lineage records, earliest first. */
  successors: readonly string[];
}
