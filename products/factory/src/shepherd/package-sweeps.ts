import type { Logger } from "@titan-design/daemon";
import type { FactoryHost } from "../host.js";
import { startSweep, type Sweep } from "../sweep.js";
import type { ShepherdServices } from "./services.js";
import { TOOLCHAIN_SWEEP_MS, sweepToolchain } from "./toolchain-sweep.js";
import { RELEASE_SWEEP_MS, sweepVersionPackages } from "./version-packages.js";

export { RELEASE_SWEEP_MS, TOOLCHAIN_SWEEP_MS };

async function sweepReleases(host: FactoryHost, services: ShepherdServices, log: Logger): Promise<void> {
  for (const note of await sweepVersionPackages(host, services)) log.info({ ...note }, "swept a Version Packages PR");
}

async function sweepToolchains(host: FactoryHost, services: ShepherdServices, log: Logger): Promise<void> {
  for (const note of await sweepToolchain(host, services)) log.info({ ...note }, "swept a toolchain adoption");
}

export interface PackageSweepOptions {
  /** How often the Version Packages sweep runs; defaults to `RELEASE_SWEEP_MS`. */
  releaseSweepMs?: number;
  /** How often the toolchain adoption sweep runs; defaults to `TOOLCHAIN_SWEEP_MS`. */
  toolchainSweepMs?: number;
}

/** No services means no Shepherd, so no package sweeps. */
export function startPackageSweeps(host: FactoryHost, services: ShepherdServices | undefined, options: PackageSweepOptions, log: Logger): Sweep[] {
  if (!services) return [];
  return [
    startSweep(() => sweepReleases(host, services, log), options.releaseSweepMs ?? RELEASE_SWEEP_MS, "version packages sweep", log),
    startSweep(() => sweepToolchains(host, services, log), options.toolchainSweepMs ?? TOOLCHAIN_SWEEP_MS, "toolchain adoption sweep", log),
  ];
}
