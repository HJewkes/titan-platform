#!/usr/bin/env node
/**
 * `aw` — thin launcher that bootstraps a Claude Code session for an
 * active-work initiative.
 *
 * Usage:
 *   aw [slug]        Launch claude with the bootstrap prompt and the
 *                    initiative's own directory under the active root as cwd.
 *                    Omit the slug to pick one interactively.
 *
 * For the management CLI (new, task, focus, session, etc.), use
 * `active-work`. This launcher deliberately rejects sub-command
 * invocations so the two surfaces stay distinct.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveLaunchCwd } from './sessions/initiatives.js';
import { parseLauncherFlags } from './launcher-args.js';
import { withLauncherLease } from './launcher-lease.js';
import { requireProfileDir } from './launcher-profile.js';
import {
  openSlugOrInit,
  pickInitiative,
  runOpen,
  runOpenSuccess,
  spawnClaude,
  type OpenSuccess,
} from './launcher-open.js';
import { runResume } from './launcher-resume.js';
import { getActiveRoot } from './utils/paths.js';
import { formatError, EXIT } from './errors.js';
import { color } from './utils/color.js';
import { exitAfterFlush } from './utils/exit.js';

const HELP_LAUNCH = [
  'aw — launch a Claude session for an active-work initiative.',
  '',
  'Usage:',
  '  aw [slug]      Bootstrap and launch a Claude session for <slug>.',
  '                 <slug> may be a facet alias (`active-work facet list`):',
  '                 it opens the owning initiative scoped to the facet.',
  '                 Omit slug to resolve the initiative from the current',
  '                 directory, falling back to an interactive picker.',
  '                 An unknown slug offers to create the initiative and',
  '                 start a session that sets it up with you.',
  '  aw --pick      Skip cwd resolution and always show the picker.',
  '  aw <slug> --adhoc',
  '                 Frame the session as ad-hoc work on the workstream',
  '                 (awaiting your task), not a handoff continuation.',
  '                 `--ad-hoc` is accepted as an alias.',
  '  aw <slug> --no-rc',
  '                 Launch without Remote Control (on by default).',
  '                 `--no-remote-control` is accepted as an alias.',
  '  aw <slug> --profile <name>',
  '                 Launch on the Claude account in ~/.claude-profiles/<name>',
  "                 (CLAUDE_CONFIG_DIR), overriding the brief's `profile:`.",
  '                 `--profile=<name>` also works. An unknown name exits',
  '                 with the list of profiles that exist.',
];

const HELP_RESUME = [
  '  aw resume <session_id> [--no-rc] [--profile <name>]',
  "                 Find the directory a session id ran in (active-work's",
  "                 session log, then every config dir's projects) and resume",
  "                 it there, under the profile's config dir if it has one.",
  '                 `--profile` resumes under that profile instead.',
  '  aw --help      Show this message.',
  '  aw --version   Print version.',
  '',
  'For the full management CLI (new, task, focus, session, …) use `active-work`.',
  '',
];

export function helpText(): string {
  return [...HELP_LAUNCH, ...HELP_RESUME].join('\n');
}

/** Print help or version when asked; true when the invocation is fully handled. */
function printInfoAndExit(args: string[]): boolean {
  if (args.includes('--help') || args.includes('-h')) process.stdout.write(helpText());
  else if (args.includes('--version') || args.includes('-V')) process.stdout.write('0.1.0\n');
  else return false;
  return true;
}

function rejectSubcommand(): Promise<void> {
  process.stderr.write(
    color.red(
      'error: `aw` only launches a Claude session for an initiative. ' +
        'Use `active-work` for other commands.\n',
    ),
  );
  return exitAfterFlush(EXIT.USAGE);
}

export async function main(argv: string[]): Promise<void> {
  const args = argv.slice(2);
  if (printInfoAndExit(args)) return exitAfterFlush(EXIT.OK);
  if (args[0] === 'resume') {
    await runResume(argv);
    return;
  }
  // `--pick` forces the interactive picker instead of resolving from cwd;
  // `--adhoc` (alias `--ad-hoc`) reframes the prompt as ad-hoc work;
  // `--no-rc` launches without Remote Control; `--profile` picks the account.
  const { pick, adhoc, remoteControl, profile, positional, usageError } = parseLauncherFlags(args);
  if (usageError) return rejectSubcommand();

  try {
    if (profile) requireProfileDir(profile);
    const opened = await openInitiative(positional[0], { pick, adhoc });
    if (!opened) return exitAfterFlush(EXIT.OK);
    return exitAfterFlush(await launchSession(opened, { remoteControl, profile }));
  } catch (err) {
    const { message, code } = formatError(err);
    process.stderr.write(color.red(`error: ${message}\n`));
    return exitAfterFlush(code);
  }
}

/** Resolve the brief to launch; null when the picker was cancelled or empty. */
async function openInitiative(
  slug: string | undefined,
  { pick, adhoc }: { pick: boolean; adhoc: boolean },
): Promise<OpenSuccess | null> {
  if (slug !== undefined) {
    const opened = await openSlugOrInit(slug, adhoc);
    if (opened.facet) {
      process.stderr.write(color.dim(`Opening ${opened.slug} (facet ${opened.facet.name})\n`));
    }
    return opened;
  }
  // No slug: `open` first tries to resolve the initiative from the
  // current directory (unless `--pick`). It returns the picker list only
  // when the cwd doesn't uniquely match a worktree.
  const result = await runOpen({ pick, adhoc });
  if (!('picker' in result)) {
    process.stderr.write(color.dim(`Opening ${result.slug} — matched current directory.\n`));
    return result;
  }
  const choice = await pickInitiative(result.initiatives);
  return choice ? runOpenSuccess({ slug: choice, adhoc }) : null;
}

async function launchSession(
  opened: OpenSuccess,
  { remoteControl, profile }: { remoteControl: boolean; profile?: string },
): Promise<number> {
  // Not `opened.cwd_hint`: that is the dispatch answer (a registered
  // worktree, for agents that must commit). An operator's session belongs in
  // the initiative's own directory — see resolveLaunchCwd (AW-115).
  const activeRoot = getActiveRoot();
  const launchCwd = resolveLaunchCwd(activeRoot, opened.slug);
  return withLauncherLease({ activeRoot, slug: opened.slug, cwd: launchCwd }, (leaseId) =>
    spawnClaude(opened, launchCwd, { remoteControl, profile }, leaseId),
  );
}

/**
 * True when this module is the one Node was invoked to run directly (the
 * `aw` bin), not merely imported (e.g. by a test exercising
 * `openSlugOrInit` in isolation). `argv[1]` is the *bin* path — often a
 * symlink (npm global installs, `~/.local/bin/aw`) — while `import.meta.url`
 * is the real, resolved file, so the comparison has to go through
 * `realpathSync` on both sides. A path that can't be resolved just means
 * "not the entry point", not an error worth throwing over.
 */
function isEntryPoint(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  void main(process.argv);
}
