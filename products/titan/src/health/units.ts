import { existsSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import { renderCalendarTimer, renderOneshotService, SYSTEM_PATH, userUnitDir } from "../systemd/render.js";
import type { HostEnv } from "./targets.js";

export const SAMPLE_SERVICE = "titan-health-sample.service";
export const SAMPLE_TIMER = "titan-health-sample.timer";

interface SampleServiceOptions {
  /** Absolute; systemd runs it directly, so nothing depends on the user manager's PATH. */
  nodePath: string;
  /** The titan bin resolved at install time. */
  titanBin: string;
  errLog: string;
}

/**
 * One tick per start. Nice and idle IO keep it out of serve's way; the accounting lets
 * `systemctl show` cross-check the sampler's own `self` rows.
 */
export function renderSampleService(options: SampleServiceOptions): string {
  return renderOneshotService({
    description: "titan health sample (one tick)",
    argv: [options.nodePath, options.titanBin, "health", "sample"],
    nice: 10,
    idleIo: true,
    accounting: true,
    environment: { PATH: [...new Set([dirname(options.nodePath), ...SYSTEM_PATH])].join(":") },
    errLog: options.errLog,
  });
}

/**
 * Wall-clock minutes line up with the uptime fold's epoch-aligned slots. AccuracySec=1s stops
 * systemd's default one-minute coalescing from merging two ticks into one slot, and
 * Persistent=false avoids a catch-up burst after downtime that would hide a missed minute.
 */
export function renderSampleTimer(): string {
  return renderCalendarTimer({
    description: "titan health sample every minute",
    onCalendar: "*-*-* *:*:00",
    accuracySec: "1s",
    persistent: false,
    unit: SAMPLE_SERVICE,
  });
}

export const sampleUnitDir = (host: HostEnv): string => userUnitDir(host);

interface NodeProbe {
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
