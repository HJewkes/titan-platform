import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Logger } from "@titan-design/daemon";
import { factoryStateDir } from "./config.js";
import { readDeployPause } from "./deploy-pause.js";
import { readLastDeploy } from "./deploy-ports.js";
import { nodeWantedStore, PACER_SWEEP_MS, pacerStatus, pacerTick, readWanted, type DeployPacerOptions } from "./shepherd/deploy-pacer.js";
import { deployPacerPorts } from "./shepherd/redeploy.js";
import { startSweep, type Sweep } from "./sweep.js";

/** What the sweep reads from the running service. */
interface ServiceView {
  now: () => number;
  runningSha: string;
  /** The `/health` busy count, so a deploy waits for review and merge steps to finish. */
  busy: () => number;
}

const pauseReadPorts = { exists: existsSync, readFile: (path: string) => readFileSync(path, "utf8") };

/** The first tick is not awaited, so a record a restart already answered clears soon after start without holding it up. */
export function startDeployPacer(options: DeployPacerOptions | undefined, service: ServiceView, log: Logger): Sweep | undefined {
  if (options === undefined) return undefined;
  const { stateDir, spawn } = options;
  const tick = async (): Promise<void> =>
    void pacerTick({
      stateDir,
      store: options.store ?? nodeWantedStore,
      now: service.now,
      runningSha: () => service.runningSha,
      lastDeploy: () => readLastDeploy(stateDir) ?? undefined,
      busy: service.busy,
      paused: () => readDeployPause(pauseReadPorts, stateDir).paused,
      spawn,
      log: (line) => log.info({}, line),
    });
  const sweep = startSweep(tick, options.sweepMs ?? PACER_SWEEP_MS, "deploy pacer", log);
  void sweep.tick();
  return sweep;
}

/** Absent without a pacer, so a serve that does not pace deploys reports nothing it does not do. */
export function deployPendingHealth(options: DeployPacerOptions | undefined): { deployPending?: ReturnType<typeof pacerStatus> } {
  if (options === undefined) return {};
  return { deployPending: pacerStatus(readWanted(options.stateDir, options.store ?? nodeWantedStore)) };
}

/** The same bin and state dir `workflows.ts` gives Shepherd's redeploy step, so the queue and the sweep share one record. */
export const configuredDeployPacer = (env: NodeJS.ProcessEnv): DeployPacerOptions =>
  deployPacerPorts({ bin: fileURLToPath(new URL("./bin.js", import.meta.url)), stateDir: factoryStateDir(env) });
