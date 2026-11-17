import type { UpstreamSample } from "./recorder.js";
import type { UpstreamObserver } from "./timed-fetch.js";

/** What a settled call cost: its answer's size, and whether it answered at all (`git` answers null when it fails). */
interface Measured {
  bytes: number;
  ok: boolean;
}

function observe(recorder: UpstreamObserver, sample: UpstreamSample): void {
  try {
    recorder.recordUpstream(sample);
  } catch {
    // telemetry never fails a call
  }
}

/**
 * TP-6747: `timedFetch` for an upstream that is not HTTP, such as a `git` or `gh` spawn. `work.tasks` waited seconds on
 * git and GitHub with no row in the perf log, so the wait could only be inferred; each call now leaves its own row.
 */
export function timedCall<T>(recorder: UpstreamObserver | undefined, name: string, call: () => Promise<T>, measure: (value: T) => Measured): Promise<T> {
  if (recorder === undefined) return call();
  const started = performance.now();
  return call().then(
    (value) => {
      const { bytes, ok } = measure(value);
      observe(recorder, { name, ms: performance.now() - started, bytes, outcome: ok ? "ok" : "error" });
      return value;
    },
    (error: unknown) => {
      observe(recorder, { name, ms: performance.now() - started, bytes: 0, outcome: "error" });
      throw error;
    },
  );
}
