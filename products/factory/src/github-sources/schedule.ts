import type { Logger } from "@titan-design/daemon";
import { startSweep, type Sweep } from "../sweep.js";
import type { PassStamp, SourcesMode, SourcesReader } from "./mode.js";

/** The `PUSH_WATCH_TICK_MS` cadence: how late a due pass, an interval edit or a kill-switch flip can be seen. */
export const DUE_CHECK_TICK_MS = 15_000;

interface ScheduleOptions {
  sources: SourcesReader;
  pass: (signal: AbortSignal) => Promise<void>;
  now: () => number;
  log: Logger;
  stamp?: PassStamp;
}

/**
 * `startSweep` cannot change its interval, so a fixed tick asks whether a pass is due under the mode in force now; a tick that
 * is not due costs one config read and no API call. The first tick is the start pass whatever the mode. A change of effective
 * mode makes that tick due: the catch-up pass covers deliveries the ingress dropped before someone flipped the switch.
 */
export function startReconcilerSchedule({ sources, pass, now, log, stamp }: ScheduleOptions): Sweep {
  let lastEffective: SourcesMode | undefined;
  let lastPassAt: number | undefined;
  const tickOnce = async (signal: AbortSignal): Promise<void> => {
    const { effective, reason, intervalMs } = sources();
    const changed = lastEffective !== undefined && effective !== lastEffective;
    if (changed) log.info({ from: lastEffective, to: effective, reason }, `github sources: ${lastEffective} → ${effective} (${reason})`);
    lastEffective = effective;
    if (!changed && lastPassAt !== undefined && now() < lastPassAt + intervalMs) return;
    lastPassAt = now();
    await pass(signal);
    stamp?.record(now());
  };
  return startSweep(tickOnce, DUE_CHECK_TICK_MS, "reconciler schedule", log);
}
