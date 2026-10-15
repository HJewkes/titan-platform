import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Logger } from "@titan-design/daemon";
import { z } from "zod";
import { cachedAncestry, gitAncestry, runningHolds } from "./build-ancestry.js";
import { FACTORY_REPO } from "./build-info.js";
import { factoryStateDir } from "./config.js";
import { readDeployHolds } from "./deploy-pause.js";
import { readLastDeploy } from "./deploy-ports.js";
import type { CommandResult } from "./service-control.js";
import { runCommand } from "./service-ports.js";
import { DEPLOY_NOW_LABEL, nodeWantedStore, PACER_SWEEP_MS, pacerStatus, pacerTick, readWanted, type DeployPacerOptions, type ExpressProbe } from "./shepherd/deploy-pacer.js";
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

type Run = (file: string, args: readonly string[]) => Promise<CommandResult | undefined>;

const LabelNames = z.array(z.string());

/** Any gh failure reads as unlabelled, so a GitHub outage falls back to normal pacing instead of deploying early. */
async function carriesDeployNow(run: Run, repo: string, sha: string): Promise<boolean> {
  const result = await run("gh", ["api", `repos/${repo}/commits/${sha}/pulls`, "--jq", "[.[].labels[].name]"]);
  if (result?.code !== 0) return false;
  try {
    return LabelNames.parse(JSON.parse(result.stdout)).includes(DEPLOY_NOW_LABEL);
  } catch {
    return false;
  }
}

/** A label found stays found for that sha; a miss is asked again, since the label may be added after the merge. */
export function ghDeployNow(repo: string, run: Run = runCommand): ExpressProbe {
  const labelled = new Set<string>();
  return async (sha) => {
    if (labelled.has(sha)) return true;
    const found = await carriesDeployNow(run, repo, sha);
    if (found) labelled.add(sha);
    return found;
  };
}

/** What the tick needs that only an async probe can answer, keyed by the wanted sha it was asked about. */
interface Settled {
  held?: string;
  express?: string;
}

/** A git failure reads as not held, so the deployer is still asked; a sha already spawned is not looked up on GitHub, since the label no longer changes anything. */
async function settle(options: DeployPacerOptions, runningSha: string): Promise<Settled> {
  const wanted = readWanted(options.stateDir, options.store ?? nodeWantedStore);
  if (wanted === undefined) return {};
  const held = options.isAncestor !== undefined && (await runningHolds(options.isAncestor, runningSha, wanted.sha)) === true;
  const express = options.express !== undefined && wanted.spawnedSha !== wanted.sha && (await options.express(wanted.sha));
  return { ...(held && { held: wanted.sha }), ...(express && { express: wanted.sha }) };
}

/** The first tick is not awaited, so a record a restart already answered clears soon after start without holding it up. */
export function startDeployPacer(options: DeployPacerOptions | undefined, service: ServiceView, log: Logger): Sweep | undefined {
  if (options === undefined) return undefined;
  const { stateDir, spawn } = options;
  const tick = async (): Promise<void> => {
    const settled = await settle(options, service.runningSha);
    pacerTick({
      stateDir,
      store: options.store ?? nodeWantedStore,
      now: service.now,
      runningSha: () => service.runningSha,
      runningHolds: (sha) => sha === settled.held,
      express: (sha) => sha === settled.express,
      lastDeploy: () => readLastDeploy(stateDir) ?? undefined,
      busy: service.busy,
      paused: () => readDeployHolds(pauseReadPorts, stateDir).held,
      spawn,
      log: (line) => log.info({}, line),
    });
  };
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
export const configuredDeployPacer = (env: NodeJS.ProcessEnv, checkout: string): DeployPacerOptions => ({
  ...deployPacerPorts({ bin: fileURLToPath(new URL("./bin.js", import.meta.url)), stateDir: factoryStateDir(env) }),
  isAncestor: cachedAncestry(gitAncestry(checkout)),
  ...(FACTORY_REPO !== undefined && { express: ghDeployNow(FACTORY_REPO) }),
});
