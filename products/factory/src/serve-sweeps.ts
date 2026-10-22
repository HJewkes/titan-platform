import type { Logger } from "@titan-design/daemon";
import { DEPLOY_WATCH_MS, type DeployWatch } from "./deploy-watch.js";
import { retireEndedFixers, type FixerRetirePorts } from "./shepherd/fixer-retire.js";
import type { FreezeStoreRef } from "./shepherd/freeze.js";
import { startSweep, type Sweep } from "./sweep.js";

export async function sweepFixers(ports: FixerRetirePorts, freeze: FreezeStoreRef, log: Logger): Promise<void> {
  for (const note of await retireEndedFixers(ports, freeze.get().activeFreezes())) {
    if (note.outcome === "retired") log.info({ ...note }, "retired an ended main-red fixer");
    else log.warn({ ...note }, "left an ended main-red fixer");
  }
}

/** The first tick is not awaited: its redeploy.log read and index.lock probe (lsof, pgrep) must not hold up the start. */
export function startDeployWatch(watch: DeployWatch | undefined, log: Logger): Sweep | undefined {
  if (watch?.startupWarning) log.warn({}, watch.startupWarning);
  const sweep = watch && startSweep(watch.tick, DEPLOY_WATCH_MS, "deploy watch", log);
  void sweep?.tick();
  return sweep;
}
