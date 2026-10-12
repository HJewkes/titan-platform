import { setImmediate as nextTurn } from "node:timers/promises";

/** Work a long read may do before it hands the event loop back, well under the 50 ms a /health probe can wait. */
export const SLICE_MS = 10;

/**
 * A checkpoint for a loop over many runs: awaiting it yields to the event loop once `SLICE_MS` of work has run since
 * the last yield, so serve keeps answering /health and RPCs while the loop parses run after run.
 */
export function sliceClock(now: () => number = () => performance.now()): () => Promise<void> {
  let started = now();
  return async () => {
    if (now() - started < SLICE_MS) return;
    await nextTurn();
    started = now();
  };
}
