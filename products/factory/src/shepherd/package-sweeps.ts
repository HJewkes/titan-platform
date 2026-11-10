import type { Logger } from "@titan-design/daemon";
import type { FactoryHost } from "../host.js";
import { startSweep, type Sweep } from "../sweep.js";
import { bumpConsumers, type ConsumerBumpPorts } from "./bump-consumers.js";
import { npmLatest } from "./consumer-bump.js";
import { scratchLockfileRegen } from "./lockfile-regen.js";
import type { ShepherdServices } from "./services.js";
import { TOOLCHAIN_SWEEP_MS, sweepToolchain } from "./toolchain-sweep.js";
import { RELEASE_SWEEP_MS, sweepVersionPackages } from "./version-packages.js";

export { RELEASE_SWEEP_MS, TOOLCHAIN_SWEEP_MS };

/** Consumers drift only when a release lands, so an hourly check catches each one well inside a day. */
export const CONSUMER_BUMP_SWEEP_MS = 3_600_000;

async function sweepReleases(host: FactoryHost, services: ShepherdServices, log: Logger): Promise<void> {
  for (const note of await sweepVersionPackages(host, services)) log.info({ ...note }, "swept a Version Packages PR");
}

/** An error note is something an operator must read, so it logs at warn; the rest stay at info. */
function logNote(log: Logger, note: { error?: string }, message: string): void {
  if (note.error === undefined) log.info({ ...note }, message);
  else log.warn({ ...note }, message);
}

async function sweepToolchains(host: FactoryHost, services: ShepherdServices, log: Logger): Promise<void> {
  for (const note of await sweepToolchain(host, services)) logNote(log, note, "swept a toolchain adoption");
}

/** The real npm registry and a scratch-dir install, unless a caller hands in its own. */
async function sweepConsumerBumps(host: FactoryHost, services: ShepherdServices, log: Logger, ports: ConsumerBumpPorts = { registry: npmLatest(), regen: scratchLockfileRegen() }): Promise<void> {
  for (const note of await bumpConsumers(host, services, ports)) logNote(log, note, "swept a consumer bump");
}

export interface PackageSweepOptions {
  /** How often the Version Packages sweep runs; defaults to `RELEASE_SWEEP_MS`. */
  releaseSweepMs?: number;
  /** How often the toolchain adoption sweep runs; defaults to `TOOLCHAIN_SWEEP_MS`. */
  toolchainSweepMs?: number;
  /** How often the consumer bump sweep runs; defaults to `CONSUMER_BUMP_SWEEP_MS`. */
  consumerBumpSweepMs?: number;
}

/** No services means no Shepherd, so no package sweeps. */
export function startPackageSweeps(host: FactoryHost, services: ShepherdServices | undefined, options: PackageSweepOptions, log: Logger): Sweep[] {
  if (!services) return [];
  return [
    startSweep(() => sweepReleases(host, services, log), options.releaseSweepMs ?? RELEASE_SWEEP_MS, "version packages sweep", log),
    startSweep(() => sweepToolchains(host, services, log), options.toolchainSweepMs ?? TOOLCHAIN_SWEEP_MS, "toolchain adoption sweep", log),
    startSweep(() => sweepConsumerBumps(host, services, log), options.consumerBumpSweepMs ?? CONSUMER_BUMP_SWEEP_MS, "consumer bump sweep", log),
  ];
}
