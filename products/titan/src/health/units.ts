import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { HostEnv } from "./targets.js";

export const SAMPLE_SERVICE = "titan-health-sample.service";
export const SAMPLE_TIMER = "titan-health-sample.timer";

export interface SampleServiceOptions {
  /** Absolute; systemd runs it directly, so nothing depends on the user manager's PATH. */
  nodePath: string;
  /** The titan bin resolved at install time. */
  titanBin: string;
  errLog: string;
}

/** The same four system directories titan-factory.service puts after node's own. */
const SYSTEM_PATH = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];

/** systemd expands `%` specifiers in every value below, so a literal one is doubled. */
const noSpecifiers = (value: string): string => value.replace(/%/g, "%%");

/** systemd splits on whitespace and reads C escapes inside double quotes. */
function quoteIfNeeded(value: string): string {
  return /[\s"'\\]/.test(value) ? `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : value;
}

/** ExecStart also expands `$VAR`, so a literal `$` is doubled there. */
const execArg = (value: string): string => quoteIfNeeded(noSpecifiers(value).replace(/\$/g, "$$$$"));

/**
 * One tick per start. Nice and idle IO keep it out of serve's way; the accounting lets
 * `systemctl show` cross-check the sampler's own `self` rows. The timer is what gets enabled,
 * so the service has no [Install] section. `append:` takes the rest of the line, so the log is never quoted.
 */
export function renderSampleService(options: SampleServiceOptions): string {
  const argv = [options.nodePath, options.titanBin, "health", "sample"];
  return [
    "[Unit]",
    "Description=titan health sample (one tick)",
    "",
    "[Service]",
    "Type=oneshot",
    `ExecStart=${argv.map(execArg).join(" ")}`,
    "Nice=10",
    "IOSchedulingClass=idle",
    "CPUAccounting=yes",
    "IOAccounting=yes",
    `Environment=${quoteIfNeeded(noSpecifiers(`PATH=${[...new Set([dirname(options.nodePath), ...SYSTEM_PATH])].join(":")}`))}`,
    `StandardError=append:${noSpecifiers(options.errLog)}`,
    "",
  ].join("\n");
}

/**
 * Wall-clock minutes line up with the uptime fold's epoch-aligned slots. AccuracySec=1s stops
 * systemd's default one-minute coalescing from merging two ticks into one slot, and
 * Persistent=false avoids a catch-up burst after downtime that would hide a missed minute.
 */
export function renderSampleTimer(): string {
  return [
    "[Unit]",
    "Description=titan health sample every minute",
    "",
    "[Timer]",
    "OnCalendar=*-*-* *:*:00",
    "AccuracySec=1s",
    "Persistent=false",
    `Unit=${SAMPLE_SERVICE}`,
    "",
    "[Install]",
    "WantedBy=timers.target",
    "",
  ].join("\n");
}

/** XDG says a relative XDG_CONFIG_HOME is invalid and must be ignored. */
export function sampleUnitDir({ env, home }: HostEnv): string {
  const config = env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : join(home, ".config");
  return join(config, "systemd", "user");
}

export interface NodeProbe {
  exists: (path: string) => boolean;
  realpath: (path: string) => string;
}

const CELLAR_NODE = /^(.+)\/Cellar\/([^/]+)\/[^/]+\/bin\/node$/;
const fsProbe: NodeProbe = { exists: existsSync, realpath: realpathSync };

/** A Homebrew Cellar path names one version and breaks on `brew upgrade`; the prefix symlink follows the upgrade. */
export function stableNodePath(execPath: string, probe: NodeProbe = fsProbe): string {
  const match = CELLAR_NODE.exec(execPath);
  if (!match) return execPath;
  const [, prefix, formula] = match;
  const link = formula === "node" ? `${prefix}/bin/node` : `${prefix}/opt/${formula}/bin/node`;
  return probe.exists(link) && probe.realpath(link) === probe.realpath(execPath) ? link : execPath;
}
