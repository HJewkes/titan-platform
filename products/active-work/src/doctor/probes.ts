import type { promises as fsp } from 'node:fs';
import nodePath from 'node:path';
import os from 'node:os';
import { CLIENT_HEADER } from '@titan-design/daemon';
import { isRecord } from '@titan-design/rpc-protocol/narrow';
import { isProcessAlive, probeHealth, readPidFile, resolveDaemonPort } from '../server/lifecycle.js';
import { getSupervisor } from '../setup/supervision.js';

export interface DaemonProbe {
  running: boolean;
  healthy: boolean;
  port?: number;
  version?: string;
  pid?: number;
  /** True when `/health` answered but no PID file names the daemon. */
  orphaned?: boolean;
}


/**
 * Probe by port alone, for when the PID file is absent or names a dead
 * process. A missing file used to read as "not running" outright, which is how
 * a live daemon whose file its predecessor clobbered became indistinguishable
 * from no daemon at all (AW-76). Something answering `/health` outranks the
 * bookkeeping, so adopt the pid/port/version it reports.
 */
async function probeByPort(port: number): Promise<DaemonProbe> {
  const health = await probeHealth(port);
  if (!health) return { running: false, healthy: false, port };
  return {
    running: true,
    healthy: true,
    orphaned: true,
    pid: health.pid,
    port: health.port,
    version: health.version,
  };
}

export async function defaultProbeDaemon(): Promise<DaemonProbe> {
  const entry = await readPidFile();
  if (!entry) return probeByPort(resolveDaemonPort());
  if (!isProcessAlive(entry.pid)) {
    // A pre-meta pid file records port 0; fall back to where a daemon would be.
    return probeByPort(entry.meta.port || resolveDaemonPort());
  }
  const health = await probeHealth(entry.meta.port);
  if (health) {
    return {
      running: true,
      healthy: true,
      pid: health.pid,
      port: health.port,
      version: health.version,
    };
  }
  return {
    running: true,
    healthy: false,
    pid: entry.pid,
    port: entry.meta.port,
    version: entry.meta.version,
  };
}

export async function defaultSupervisorActive(): Promise<{
  kind: string;
  active: boolean;
  path?: string;
} | null> {
  const supervisor = getSupervisor();
  if (!supervisor) return null;
  return {
    kind: supervisor.kind,
    active: await supervisor.isActive({}),
    path: supervisor.definitionPath(os.homedir()),
  };
}

export function parseMajor(version: string): number {
  const match = /^v?(\d+)\./.exec(version);
  return match ? Number(match[1]) : 0;
}

export async function fileExists(fs: typeof fsp, target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

// `setup` registers the server as `@hjewkes/active-work` (stdio), but users
// commonly wire it as `active-work` (http, pointed at the daemon). Accept
// either name.
const MCP_SERVER_NAMES = ['@hjewkes/active-work', 'active-work'];

interface McpServerEntry {
  type?: string;
  headers?: Record<string, unknown>;
}

// Any truthy value under a server name counts as a registration, however malformed.
function toMcpServerEntry(value: unknown): McpServerEntry {
  if (!isRecord(value)) return {};
  return {
    ...(typeof value.type === 'string' ? { type: value.type } : {}),
    ...(isRecord(value.headers) ? { headers: value.headers } : {}),
  };
}

export async function readMcpRegistrations(fs: typeof fsp, homeDir: string): Promise<McpServerEntry[]> {
  const configPath = nodePath.join(homeDir, '.claude.json');
  try {
    const raw = await fs.readFile(configPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || !isRecord(parsed.mcpServers)) return [];
    const servers = parsed.mcpServers;
    return MCP_SERVER_NAMES.flatMap((name) =>
      servers[name] ? [toMcpServerEntry(servers[name])] : [],
    );
  } catch {
    return [];
  }
}

// The daemon refuses a POST that has neither an Origin nor this header with a 403,
// and Claude Code's http transport sends no Origin.
export function lacksClientHeader(entry: McpServerEntry): boolean {
  if (entry.type !== 'http') return false;
  const names = Object.keys(entry.headers ?? {}).map((name) => name.toLowerCase());
  return !names.includes(CLIENT_HEADER);
}

