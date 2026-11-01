import type { GitHubPort } from "@titan-design/github";
import type { ImplementerRunner } from "../agent-chat-implementer.js";
import type { FixTasks } from "../shepherd/main-red.js";
import type { LandState } from "./schemas.js";

export interface CommandRun {
  status: number;
  stdout: string;
  stderr: string;
}

export interface CommandRequest {
  cwd: string;
  env: Record<string, string>;
  /** Written to the child's stdin; validators read the agent's JSON from it. */
  input?: string;
  signal: AbortSignal;
}

interface ExtractRequest {
  prompt: string;
  model: string;
  maxBudgetUsd: number;
  cwd: string;
  signal: AbortSignal;
}

export interface ShepherdPort {
  /** Idempotent on repo#pr, as `shepherd.register` is. */
  register(request: { repo: string; pr: number; task: string; implementer: string }): Promise<{ runId: string }>;
  /** Waits until Shepherd merges or stops the PR, or its head moves off `head`. */
  land(request: { repo: string; pr: number; head: string }, signal: AbortSignal): Promise<LandState>;
}

/** Everything a build touches outside its run, so a test stubs each and no test runs a command or an agent. */
export interface BuildSurfacePorts {
  now(): number;
  readText(path: string): Promise<string>;
  /** Never rejects on a non-zero exit: the status is the answer. */
  run(argv: readonly string[], request: CommandRequest): Promise<CommandRun>;
  /** Every `*.json` file in `dir`, parsed; a missing directory is none. */
  readEvidence(dir: string): Promise<{ path: string; json: unknown }[]>;
  github: Pick<GitHubPort, "getHeadSha" | "ensureBranch" | "findPr" | "openPr">;
  implementer: ImplementerRunner;
  /** One structured `claude -p` turn; returns the answer and what it cost. */
  extract(request: ExtractRequest): Promise<{ output: unknown; costUsd?: number }>;
  shepherd: ShepherdPort;
  /** Where a broken gate or spec files its task. */
  tasks: Pick<FixTasks, "findByTag" | "add">;
}
