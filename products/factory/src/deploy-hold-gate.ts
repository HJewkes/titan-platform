import { describeHolds, readDeployHolds } from "./deploy-pause.js";
import { syncMorningHold, type MorningHoldPorts } from "./morning-deploy-hold.js";

interface HoldGateOptions {
  stateDir: string;
  /** Absent skips the Morning sync, so only the hold files decide. */
  morningQueuesDir?: string | undefined;
  now: number;
}

/**
 * The `deploy held:` refusal, or undefined when no hold stands. Called under the lock and before any sha is resolved, so no
 * target, however new, gets past a pause. The Morning hold syncs first, so a Morning item stops a deploy
 * run by hand or by Shepherd while serve is down. A one-shot deploy has no earlier read, so `emptyBefore` is 0: it can set a
 * Morning hold but never clears one; serve's pacer clears it.
 */
export function deployHeld(ports: MorningHoldPorts, warn: (line: string) => void, { stateDir, morningQueuesDir, now }: HoldGateOptions): string | undefined {
  if (morningQueuesDir !== undefined) {
    const synced = syncMorningHold(ports, { stateDir, queuesDir: morningQueuesDir, now: new Date(now).toISOString(), emptyBefore: 0 });
    if (synced.failed !== undefined) warn(`warning: the Morning deploy hold was not synced: ${synced.failed}\n`);
  }
  const state = readDeployHolds(ports, stateDir);
  return state.held ? `deploy held: ${describeHolds(state).join("; ")}; clear with titan-factory service pause --clear` : undefined;
}
