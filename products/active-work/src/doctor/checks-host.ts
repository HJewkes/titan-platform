import { promises as fsp } from 'node:fs';
import nodePath from 'node:path';
import os from 'node:os';
import { CLIENT_HEADER } from '@titan-design/daemon';
import { getActiveRoot } from '../utils/paths.js';
import {
  defaultProbeDaemon,
  defaultSupervisorActive,
  fileExists,
  lacksClientHeader,
  parseMajor,
  readMcpRegistrations,
} from './probes.js';
import type { DoctorCheck, DoctorDeps } from './index.js';

export async function checkNode(deps: DoctorDeps): Promise<DoctorCheck> {
  const version = deps.nodeVersion ?? process.version;
  const min = deps.minNodeMajor ?? 22;
  const major = parseMajor(version);
  if (major >= min) {
    return { name: 'node', status: 'ok', detail: `${version} (>= ${min})` };
  }
  return {
    name: 'node',
    status: 'fail',
    detail: `${version} is older than the required Node ${min}`,
  };
}

export async function checkActiveRoot(deps: DoctorDeps): Promise<DoctorCheck> {
  const fs = deps.fs ?? fsp;
  const activeRoot = deps.activeRoot ?? getActiveRoot();
  if (!(await fileExists(fs, activeRoot))) {
    return {
      name: 'active-root',
      status: 'fail',
      detail: `${activeRoot} does not exist — run \`active-work setup\``,
    };
  }
  const schemaFile = nodePath.join(activeRoot, '.schema-version');
  if (!(await fileExists(fs, schemaFile))) {
    return {
      name: 'active-root',
      status: 'warn',
      detail: `${activeRoot} exists but has no .schema-version`,
    };
  }
  return { name: 'active-root', status: 'ok', detail: activeRoot };
}

function orphanedDaemonCheck(where: string): DoctorCheck {
  // Answering but unfiled: `mcp stop`/`mcp restart` key off the PID file and
  // will not find it, so this needs saying even though the daemon is fine.
  return {
    name: 'daemon',
    status: 'warn',
    detail:
      `running (${where}) but no pid file — \`mcp stop\`/\`mcp restart\` ` +
      'cannot see it; restart it through your supervisor to re-file it',
  };
}

export async function checkDaemon(deps: DoctorDeps): Promise<DoctorCheck> {
  const probe = await (deps.probeDaemon ?? defaultProbeDaemon)();
  const where = `pid ${probe.pid ?? '?'}, port ${probe.port ?? '?'}, v${probe.version ?? '?'}`;
  if (probe.running && probe.healthy && probe.orphaned === true) return orphanedDaemonCheck(where);
  if (probe.running && probe.healthy) {
    return { name: 'daemon', status: 'ok', detail: `running (${where})` };
  }
  if (probe.running && !probe.healthy) {
    return {
      name: 'daemon',
      status: 'warn',
      detail: `pid ${probe.pid ?? '?'} is alive but /health did not answer`,
    };
  }
  // Name the port we probed: a daemon started on a non-default `--port` with
  // no pid file to record it is invisible here, and that beats implying none.
  const probed = probe.port === undefined ? '' : ` (nothing answered port ${probe.port})`;
  return {
    name: 'daemon',
    status: 'warn',
    detail: `not running${probed} — start it with \`active-work mcp serve --detach\``,
  };
}

export async function checkMcp(deps: DoctorDeps): Promise<DoctorCheck> {
  const fs = deps.fs ?? fsp;
  const homeDir = deps.homeDir ?? os.homedir();
  const entries = await readMcpRegistrations(fs, homeDir);
  if (entries.length === 0) {
    return {
      name: 'mcp-registration',
      status: 'warn',
      detail: 'not registered with Claude Code — run `active-work setup`',
    };
  }
  if (entries.some(lacksClientHeader)) {
    return {
      name: 'mcp-registration',
      status: 'warn',
      detail: `http registration has no \`${CLIENT_HEADER}\` header, so the daemon answers 403 — add \`"headers": { "${CLIENT_HEADER}": "claude-code" }\``,
    };
  }
  return { name: 'mcp-registration', status: 'ok', detail: 'registered in ~/.claude.json' };
}

export async function checkSkill(deps: DoctorDeps): Promise<DoctorCheck> {
  const fs = deps.fs ?? fsp;
  const homeDir = deps.homeDir ?? os.homedir();
  const skill = nodePath.join(homeDir, '.claude', 'skills', 'active-work', 'SKILL.md');
  if (await fileExists(fs, skill)) {
    return { name: 'skill', status: 'ok', detail: skill };
  }
  return {
    name: 'skill',
    status: 'warn',
    detail: 'skill not installed in ~/.claude/skills — run `active-work setup`',
  };
}

export async function checkSupervisor(deps: DoctorDeps): Promise<DoctorCheck> {
  const result = await (deps.supervisorActive ?? defaultSupervisorActive)();
  if (!result) {
    return {
      name: 'supervision',
      status: 'ok',
      detail: `no supervisor integration for ${process.platform} (optional)`,
    };
  }
  const where = result.path ? ` (${result.path})` : '';
  if (result.active) {
    return {
      name: 'supervision',
      status: 'ok',
      detail: `${result.kind} agent is loaded${where}`,
    };
  }
  return {
    name: 'supervision',
    status: 'warn',
    detail: `${result.kind} supervisor not active${where} — re-run \`active-work setup\` to enable`,
  };
}

