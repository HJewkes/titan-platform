import type { StepRoute } from "@titan-design/workflow";
import type { MergeWakeConfig } from "./config.js";
import { execChore, POST_MERGE_TIMEOUT_MS, type ChoreExec } from "./workflows/post-merge.js";

/*
 * Interim product-side adapter: TP-1558 moves the merge wake onto the host scheduler's settle-window trigger (TP-1555),
 * and this module is deleted then. A serve restart inside the window drops the pending wake; the 10-minute timer covers it.
 */

const MERGE_WAKE_STEP = "sh-landed";
const DEFAULT_SETTLE_MS = 20_000;

/** Absorbs events into one fire per window. */
export interface MergeWake {
  event(): void;
}

interface SettleTriggerDeps {
  settleMs: number;
  fire: () => Promise<void>;
  /** Tests pass a fake clock's timer; absent means an unref'd setTimeout, so a pending wake never holds serve open. */
  setTimer?: (run: () => void, ms: number) => void;
  onError?: (error: unknown) => void;
}

/** The first event arms the window; events inside it are absorbed, and the fire runs once when it ends. */
export function settleTrigger(deps: SettleTriggerDeps): MergeWake {
  const setTimer = deps.setTimer ?? ((run, ms) => void setTimeout(run, ms).unref());
  let armed = false;
  const fire = () => {
    armed = false;
    deps.fire().catch((error: unknown) => deps.onError?.(error));
  };
  return {
    event() {
      if (armed) return;
      armed = true;
      setTimer(fire, deps.settleMs);
    },
  };
}

/** Only a recorded `sh-landed` is a merge; a wake never changes the step's outcome. */
function mergeWakeRoute(route: StepRoute, wake: MergeWake): StepRoute {
  return {
    ...route,
    runner: {
      run: async (input) => {
        const outcome = await route.runner.run(input);
        if (outcome.ok) wake.event();
        return outcome;
      },
    },
  };
}

/** Wraps the shepherd route set's `sh-landed`; no wake leaves the routes as they are. */
export function withMergeWake(routes: readonly StepRoute[], wake: MergeWake | undefined): StepRoute[] {
  if (!wake) return [...routes];
  return routes.map((route) => (route.match === MERGE_WAKE_STEP ? mergeWakeRoute(route, wake) : route));
}

interface MergeWakePorts {
  exec?: ChoreExec;
  log?: (line: string) => void;
  setTimer?: SettleTriggerDeps["setTimer"];
}

/** The configured argv runs with no shell; its outcome goes to the serve log, and a failure waits for the backstop tick. */
export function configuredMergeWake(config: MergeWakeConfig | undefined, ports: MergeWakePorts = {}): MergeWake | undefined {
  if (!config) return undefined;
  const { exec = execChore, log = console.warn, setTimer } = ports;
  const fire = async () => {
    const result = await exec(config.argv, { cwd: config.cwd, timeoutMs: config.timeoutMs ?? POST_MERGE_TIMEOUT_MS, env: process.env });
    const failed = result.error !== undefined || result.timedOut || result.exitCode !== 0;
    log(`shepherd: merge-wake ${failed ? "failed" : "ran"} ${JSON.stringify({ exitCode: result.exitCode, signal: result.signal, timedOut: result.timedOut, error: result.error })}`);
  };
  return settleTrigger({ settleMs: config.settleMs ?? DEFAULT_SETTLE_MS, fire, setTimer, onError: (error) => log(`shepherd: merge-wake threw ${String(error)}`) });
}
