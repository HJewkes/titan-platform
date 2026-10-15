import type { Logger } from "@titan-design/daemon";
import { observeAgentChatCalls, type AgentChatCall } from "@titan-design/agent-dispatch";

type Observe = (report: (call: AgentChatCall) => void, options: { now?: () => number }) => () => void;

interface AgentChatTimingOptions {
  log: Logger;
  now?: () => number;
  thresholdMs?: number;
  windowMs?: number;
  observe?: Observe;
}

interface AgentChatTiming {
  stop(): void;
}

/** Nearest-rank percentile of an ascending, non-empty list. */
function nearestRank(sorted: readonly number[], percentile: number): number {
  const rank = Math.ceil((percentile / 100) * sorted.length);
  return sorted[Math.max(rank, 1) - 1]!;
}

function summarize(log: Logger, verb: string, durations: number[], thresholdMs: number, windowMs: number): void {
  const sorted = [...durations].sort((a, b) => a - b);
  const over5s = sorted.filter((ms) => ms > thresholdMs).length;
  log.info({ verb, count: sorted.length, over5s, p95Ms: nearestRank(sorted, 95), maxMs: sorted.at(-1)!, windowMs }, "agent-chat calls");
}

/**
 * Warns on each agent-chat call slower than the threshold and, once per window, logs one
 * "agent-chat calls" line per verb so the hourly p95 of `agent ls` and `agent spawn` reads
 * straight from serve.err.log. A window with no calls for a verb logs nothing for it: a
 * reader must take a missing hour as "no calls", not as "fast".
 */
export function logAgentChatCalls(options: AgentChatTimingOptions): AgentChatTiming {
  const { log, now, thresholdMs = 5_000, windowMs = 3_600_000, observe = observeAgentChatCalls } = options;
  let byVerb = new Map<string, number[]>();
  const unobserve = observe((call) => {
    if (call.ms > thresholdMs) log.warn({ verb: call.verb, ms: call.ms, outcome: call.outcome }, "agent-chat call slow");
    const durations = byVerb.get(call.verb) ?? [];
    durations.push(call.ms);
    byVerb.set(call.verb, durations);
  }, now === undefined ? {} : { now });
  const timer = setInterval(() => {
    const window = byVerb;
    byVerb = new Map();
    for (const [verb, durations] of window) summarize(log, verb, durations, thresholdMs, windowMs);
  }, windowMs);
  timer.unref();
  return {
    stop() {
      clearInterval(timer);
      unobserve();
    },
  };
}
