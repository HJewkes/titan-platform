/**
 * The subprocess seam the ported burndown helpers take, from agent-chat's burndown `exec.ts`. Only the types come
 * across: the broker keeps `run` (G-10), so every ported caller is handed its runner.
 */

export interface RunResult {
  status: number | null;
  stdout: string;
  /** Read only to classify a failure (an HTTP status); never relayed, since it can quote content. */
  stderr?: string;
  /** Set when the child was killed for outliving its timeout, so a caller can tell "slow" from "broken". */
  timedOut?: boolean;
}

export interface RunOptions {
  /** Overrides the runner's default timeout for one call whose child is known to run longer. */
  timeoutMs?: number;
}

export type Runner = (bin: string, args: string[], cwd?: string, options?: RunOptions) => RunResult;
