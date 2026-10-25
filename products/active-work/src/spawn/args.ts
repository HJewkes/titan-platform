import { Command } from 'commander';
import { UsageError } from '../errors.js';
import { runSpawn, type BriefSource, type SpawnDeps, type SpawnPlan } from './run.js';

export const LEAST_USED = 'least-used';

export interface SpawnFlags {
  host?: string;
  account?: string;
  briefFile?: string;
  briefStdin?: boolean;
  cwd?: string;
  briefing?: string;
  surface?: string;
  remoteControl?: boolean;
}

export function briefSource(flags: SpawnFlags): BriefSource {
  if (flags.briefFile !== undefined && flags.briefStdin === true) {
    throw new UsageError('pass one of --brief-file and --brief-stdin, not both');
  }
  if (flags.briefFile !== undefined) return { kind: 'file', path: flags.briefFile };
  if (flags.briefStdin === true) return { kind: 'stdin' };
  throw new UsageError('a brief is required: pass --brief-file <path> or --brief-stdin');
}

export function toPlan(name: string, profile: string, flags: SpawnFlags, shellCwd: string): SpawnPlan {
  return {
    name,
    profile,
    brief: briefSource(flags),
    cwd: flags.cwd ?? shellCwd,
    account: flags.account ?? LEAST_USED,
    host: flags.host,
    briefing: flags.briefing,
    surface: flags.surface,
    remoteControl: flags.remoteControl === true ? true : undefined,
  };
}

/**
 * Attached to commander directly, never through the registry: every registry
 * command is also an MCP tool, and the MCP daemon's environment has no
 * `AGENT_CHAT_NAME`, so a spawn sent through it would reach the broker as the
 * human and skip the coordinator depth cap and the Remote Control rule. From
 * a shell, the caller's identity travels with it.
 */
export function attachSpawnCommand(program: Command, deps: SpawnDeps): void {
  program
    .command('spawn')
    .description('Spawn an agent through agent-chat, as yourself, on the least-used account by default')
    .argument('<name>', 'peer name for the new agent')
    .argument('<profile>', 'agent-chat profile to spawn')
    .option('--host <host>', 'host alias or hostname; omitted means the broker host')
    .option('--account <account>', `account name, or ${LEAST_USED} (the default)`)
    .option('--brief-file <path>', 'read the brief from this file')
    .option('--brief-stdin', 'read the brief from stdin')
    .option('--cwd <dir>', 'directory the agent starts in (default: this shell)')
    .option('--briefing <slug>', 'active-work slug whose orientation prefixes the brief')
    .option('--surface <surface>', "override the profile's surface")
    .option('--remote-control', 'enable Remote Control for the agent')
    .action(async (name: string, profile: string, flags: SpawnFlags) => {
      const code = await runSpawn(toPlan(name, profile, flags, deps.cwd), deps);
      await deps.exit(code);
    });
}
