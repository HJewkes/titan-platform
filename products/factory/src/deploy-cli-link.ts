import { randomUUID } from "node:crypto";
import { lstatSync, readlinkSync, renameSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { deployedBinPath } from "./deploy-checkout.js";
import { serviceRunsFromCheckout } from "./deploy-bootstrap.js";
import type { DeployPorts } from "./deploy.js";

/** Where the CLI is resolved from: seats and the broker run `titan-factory` through this path. */
export interface CliLinkPorts {
  linkPath: string;
}

export const systemCliLinkPorts = (home: string = homedir()): CliLinkPorts => ({ linkPath: join(home, ".local", "bin", "titan-factory") });

const FACTORY_BIN_SUFFIX = "/products/factory/dist/bin.js";

/**
 * Repoints a factory-build symlink at `bin`, so the CLI on PATH is the build the service just rolled out
 * and never a stale checkout's. A regular file, a foreign symlink and an absent path are left alone;
 * the swap is a rename over the link, so no reader sees it missing.
 */
export function relinkCli(ports: CliLinkPorts, bin: string): string {
  const { linkPath } = ports;
  if (!isAbsolute(bin)) return `CLI link left alone: ${bin} is not absolute`;
  let target: string;
  try {
    if (!lstatSync(linkPath).isSymbolicLink()) return `CLI link left alone: ${linkPath} is not a symlink`;
    target = readlinkSync(linkPath);
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return `CLI link left alone: ${linkPath} does not exist`;
    throw err;
  }
  const current = resolve(dirname(linkPath), target);
  if (current === bin) return `CLI link already current: ${linkPath} -> ${bin}`;
  if (!current.endsWith(FACTORY_BIN_SUFFIX)) return `CLI link left alone: ${linkPath} points at ${current}, which is not a factory build`;
  // A unique name means a leftover from a crashed run can never collide, and we only ever delete what we created.
  const staged = `${linkPath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  symlinkSync(bin, staged);
  try {
    renameSync(staged, linkPath);
  } catch (err) {
    unlinkSync(staged);
    throw err;
  }
  return `CLI link repointed: ${linkPath} -> ${bin} (was ${current})`;
}

/**
 * The deploy verb's last step: relink only after an exit-0 deploy whose service runs the checkout, so a
 * prepare-only deploy leaves CLI and serve matching. A relink failure warns and never changes the exit code.
 */
export function relinkAfterDeploy(args: { code: number; ports: DeployPorts; checkout: string; link: CliLinkPorts; io: { stdout: (t: string) => void; stderr: (t: string) => void } }): void {
  const { code, ports, checkout, link, io } = args;
  if (code !== 0 || !serviceRunsFromCheckout(ports, checkout)) return;
  try {
    io.stdout(`${relinkCli(link, deployedBinPath(checkout))}\n`);
  } catch (err) {
    io.stderr(`warning: could not repoint the titan-factory CLI: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}
