import type { Logger } from "@titan-design/daemon";
import type { FactoryHost } from "../host.js";
import type { ShepherdServices } from "./commands.js";
import { TOOLCHAIN_SWEEP_MS, sweepToolchain } from "./toolchain-sweep.js";
import { RELEASE_SWEEP_MS, sweepVersionPackages } from "./version-packages.js";

export { RELEASE_SWEEP_MS, TOOLCHAIN_SWEEP_MS };

export async function sweepReleases(host: FactoryHost, services: ShepherdServices, log: Logger): Promise<void> {
  for (const note of await sweepVersionPackages(host, services)) log.info({ ...note }, "swept a Version Packages PR");
}

export async function sweepToolchains(host: FactoryHost, services: ShepherdServices, log: Logger): Promise<void> {
  for (const note of await sweepToolchain(host, services)) log.info({ ...note }, "swept a toolchain adoption");
}
