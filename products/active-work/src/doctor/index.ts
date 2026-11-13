/**
 * `active-work doctor` — aggregate health checks for a local install (AW-4).
 *
 * Verifies the pieces `active-work setup` wires up: Node version, the active
 * root + schema version, the MCP daemon, Claude Code MCP registration, the
 * installed skill, and (if the platform supports it) daemon supervision.
 *
 * Every probe is injectable so the checks are unit-testable without a real
 * daemon, filesystem layout, or service manager.
 */
import type { promises as fsp } from 'node:fs';
import type { LeaseSweepResult } from '../sessions/lease.js';
import type { DaemonProbe } from './probes.js';
import {
  checkActiveRoot,
  checkDaemon,
  checkMcp,
  checkNode,
  checkSkill,
  checkSupervisor,
} from './checks-host.js';
import {
  checkArtifactHashes,
  checkLeases,
  checkNoteTitles,
  checkSessions,
  checkWorkspaceIndexRefs,
} from './checks-data.js';

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface DoctorCheck {
  name: string;
  status: CheckStatus;
  detail: string;
}

interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
}

export interface DoctorDeps {
  fs?: typeof fsp;
  activeRoot?: string;
  homeDir?: string;
  /** Node version string like `process.version` (`v22.4.0`). */
  nodeVersion?: string;
  /** Minimum supported Node major (defaults to 22). */
  minNodeMajor?: number;
  /** Probe the daemon; defaults to reading the pid file + `/health`. */
  probeDaemon?: () => Promise<DaemonProbe>;
  /** Whether a supervisor already owns the daemon; null when unsupported. */
  supervisorActive?: () => Promise<{ kind: string; active: boolean; path?: string } | null>;
  /** Sweep session leases; defaults to the real `.sessions/` walk. */
  sweepLeases?: (activeRoot: string) => Promise<LeaseSweepResult>;
  /**
   * Whether the caller may see an initiative named; findings under any other are left out (TP-5556). An allow
   * list, since the workspace index names initiatives that may be gone from the root. Defaults to every one.
   */
  shown?: (slug: string) => boolean;
}

function checkInstall(deps: DoctorDeps): Promise<DoctorCheck[]> {
  return Promise.all([
    checkNode(deps),
    checkActiveRoot(deps),
    checkDaemon(deps),
    checkMcp(deps),
    checkSkill(deps),
    checkSupervisor(deps),
  ]);
}

/** Run all health checks and return a report. `ok` is false iff any check failed. */
export async function runDoctor(deps: DoctorDeps = {}): Promise<DoctorReport> {
  const [installChecks, sessionChecks, noteTitles, artifactHashes, leases, workspaceIndex] =
    await Promise.all([
      checkInstall(deps),
      checkSessions(deps),
      checkNoteTitles(deps),
      checkArtifactHashes(deps),
      checkLeases(deps),
      checkWorkspaceIndexRefs(deps),
    ]);
  const checks = [
    ...installChecks,
    ...sessionChecks,
    noteTitles,
    artifactHashes,
    leases,
    workspaceIndex,
  ];
  return { ok: checks.every((c) => c.status !== 'fail'), checks };
}
