/**
 * Duration of each agent-chat CLI call, reported to opt-in observers so a
 * long-lived caller can tell a slow roster read from a slow spawn.
 *
 * Only the verb is reported. Later argv words carry peer names and, for a
 * spawn, `--briefing` text, so they never leave this module.
 */

import type { SafeExecResult } from "./exec.js";
import { ExecTimeoutError } from "./exec.js";
import { DispatchTimeoutError } from "./dispatch.js";

export type AgentChatCall = {
  verb: string;
  ms: number;
  outcome: "ok" | "refused" | "timeout" | "error";
};

type Observer = { report: (call: AgentChatCall) => void; now: () => number };

const observers = new Set<Observer>();

/** Returns the unsubscribe. `now` is injectable so tests need no real waiting. */
export function observeAgentChatCalls(
  report: (call: AgentChatCall) => void,
  options: { now?: () => number } = {},
): () => void {
  const observer = { report, now: options.now ?? Date.now };
  observers.add(observer);
  return () => observers.delete(observer);
}

/** `agent <sub>` for the agent verbs, otherwise the first word (`ask`, `answers`, `dismiss`). */
export function agentChatVerb(args: readonly string[]): string {
  if (args.length === 0) return "unknown";
  return args[0] === "agent" && args.length > 1 ? `agent ${args[1]}` : args[0]!;
}

function outcomeOfError(err: unknown): AgentChatCall["outcome"] {
  return err instanceof DispatchTimeoutError || err instanceof ExecTimeoutError
    ? "timeout"
    : "error";
}

/** Timing must never fail a call, so an observer that throws is ignored. */
function notify(active: Observer[], starts: number[], verb: string, outcome: AgentChatCall["outcome"]): void {
  active.forEach((observer, i) => {
    try {
      observer.report({ verb, ms: observer.now() - starts[i]!, outcome });
    } catch {
      // ignored by design: see the doc comment
    }
  });
}

/** Runs `run` unchanged, reporting its duration and outcome when anything observes. */
export async function timeAgentChatCall(
  args: readonly string[],
  run: () => Promise<SafeExecResult>,
): Promise<SafeExecResult> {
  if (observers.size === 0) return run();
  const active = [...observers];
  const starts = active.map((observer) => observer.now());
  const verb = agentChatVerb(args);
  try {
    const result = await run();
    notify(active, starts, verb, result.status === 0 ? "ok" : "refused");
    return result;
  } catch (err) {
    notify(active, starts, verb, outcomeOfError(err));
    throw err;
  }
}
