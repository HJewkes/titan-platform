import { useEffect, useState } from "react";
import type { ArRunView } from "../../server/autoresearch-view.js";
import { useInvalidate } from "../data/rpc.js";

export const RUN_POLL_MS = 15_000;
const TICK_MS = 1_000;

/**
 * Interim until the factory is an events-relay source (design §4 item 4, gap G15): refetch the run on an interval while it
 * runs. Slice C6 deletes this hook when `autoresearch.run` joins the relay's invalidation list.
 */
export function useRunPoll(status: ArRunView["status"], intervalMs: number = RUN_POLL_MS): void {
  const invalidate = useInvalidate();
  useEffect(() => {
    if (status !== "running") return;
    const timer = setInterval(() => invalidate(["autoresearch.run"]), intervalMs);
    return () => clearInterval(timer);
  }, [status, intervalMs, invalidate]);
}

/** The clock running timers read; it ticks only while something is live, so a finished run renders once. */
export function useNow(ticking: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [ticking]);
  return now;
}
