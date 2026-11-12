import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as clackPrompts from '@clack/prompts';
import newCommand from './commands/new.js';
import openCommand from './commands/open.js';
import { agentCaller } from './commands/_done-when-gate.js';
import { buildClaudeArgs } from './launcher-args.js';
import { buildLauncherEnv } from './launcher-lease.js';
import { launchProfileEnv } from './launcher-profile.js';
import { defaultTitleFromSlug, isInvalidSlugMiss, shouldOfferInit } from './launcher-init.js';
import { getActiveRoot } from './utils/paths.js';
import { EXIT, NotFoundError } from './errors.js';
import { color } from './utils/color.js';
import { exitAfterFlush } from './utils/exit.js';
import type { CommandContext } from './registry/index.js';

interface InitiativeSummary {
  slug: string;
  title: string;
  state: 'focused' | 'backburner' | 'paused' | 'done';
  rank?: number;
}

export interface OpenSuccess {
  slug: string;
  prompt: string;
  cwd_hint: string;
  channels?: string[];
  profile?: string;
  resolved_from?: 'slug' | 'cwd';
  facet?: { name: string };
}

interface PickerResult {
  picker: true;
  initiatives: InitiativeSummary[];
}

type OpenResult = OpenSuccess | PickerResult;

function launcherContext(): CommandContext {
  return { activeRoot: getActiveRoot(), warnings: [], format: 'json',
    cwd: process.cwd(),
    caller: agentCaller(process.env),
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** `open` with a slug always resolves to a brief; the picker only answers a slug-less call. */
export async function runOpenSuccess(
  opts: { slug: string; adhoc?: boolean; init?: boolean },
): Promise<OpenSuccess> {
  const result = await runOpen(opts);
  if ('picker' in result) throw new Error(`open returned a picker for slug '${opts.slug}'`);
  return result;
}

export async function runOpen(
  opts: { slug?: string; pick?: boolean; adhoc?: boolean; init?: boolean } = {},
): Promise<OpenResult> {
  const ctx = launcherContext();
  const parsed = openCommand.args.parse({
    ...(opts.slug ? { slug: opts.slug } : {}),
    ...(opts.pick ? { pick: true } : {}),
    ...(opts.adhoc ? { adhoc: true } : {}),
    ...(opts.init ? { init: true } : {}),
    // This launcher records a `launcher` lease of its own around the spawned
    // session, so `open` must not also file a `oneshot` one — two leases for
    // one session make it its own sibling on the next bootstrap.
    lease_mode: 'defer' as const,
  });
  return openCommand.run(parsed, ctx);
}

/**
 * Open `slug`; when nothing matches and someone is at the terminal, offer to
 * scaffold it and open an init session instead (TP-356).
 */
export async function openSlugOrInit(
  slug: string,
  adhoc: boolean,
  open: typeof runOpenSuccess = runOpenSuccess,
): Promise<OpenSuccess> {
  try {
    return await open({ slug, adhoc });
  } catch (err) {
    const isTTY = Boolean(process.stdin.isTTY);
    if (shouldOfferInit({ error: err, slug, isTTY })) return initInitiative(slug, err);
    if (isTTY && isInvalidSlugMiss({ error: err, slug })) {
      throw new NotFoundError(
        `${errorMessage(err)}\nTo create it, use a lowercase kebab-case slug (e.g. my-new-thing).`,
      );
    }
    throw err;
  }
}

async function initInitiative(slug: string, notFound: unknown): Promise<OpenSuccess> {
  process.stderr.write(color.dim(`${errorMessage(notFound)}\n`));
  const create = await clackPrompts.confirm({
    message: `No initiative '${slug}'. Create it and start a session to set it up?`,
    initialValue: true,
  });
  if (clackPrompts.isCancel(create) || !create) throw notFound;
  const title = await clackPrompts.text({
    message: 'Title',
    initialValue: defaultTitleFromSlug(slug),
    validate: (value) => (value?.trim() ? undefined : 'A title is required.'),
  });
  if (clackPrompts.isCancel(title)) return exitAfterFlush(EXIT.OK);
  const parsed = newCommand.args.parse({ slug, title: title.trim() });
  const created = await newCommand.run(parsed, launcherContext());
  process.stderr.write(color.dim(`Created ${slug} at ${created.dir}\n`));
  return runOpenSuccess({ slug, init: true });
}

const STATE_LABEL: Record<InitiativeSummary['state'], string> = {
  focused: 'focused',
  backburner: 'backburner',
  paused: 'paused',
  done: 'done',
};

export async function pickInitiative(initiatives: InitiativeSummary[]): Promise<string | null> {
  if (initiatives.length === 0) {
    process.stderr.write(
      color.red('No initiatives found. Create one with `active-work new <slug>`.\n'),
    );
    return null;
  }
  const choice = await clackPrompts.select({
    message: 'Pick an initiative to open',
    options: initiatives.map((i) => {
      const rank = i.rank !== undefined ? ` · rank ${i.rank}` : '';
      return {
        value: i.slug,
        label: `${i.title} (${i.slug})`,
        hint: `${STATE_LABEL[i.state]}${rank}`,
      };
    }),
  });
  if (clackPrompts.isCancel(choice)) return null;
  return String(choice);
}

interface LaunchOptions {
  remoteControl: boolean;
  /** `--profile`, already checked to exist; beats `opened.profile`. */
  profile?: string;
}

/** Resolve with the exit code `aw` should return once `child` ends or fails to start. */
export function awaitChild(child: ChildProcess, notFoundMessage: string): Promise<number> {
  return new Promise((resolve) => {
    child.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        process.stderr.write(color.red(notFoundMessage));
        resolve(127);
        return;
      }
      process.stderr.write(color.red(`error: failed to launch claude: ${err.message}\n`));
      resolve(EXIT.GENERIC);
    });
    child.on('exit', (code, signal) => {
      if (signal) {
        resolve(128 + (signal === 'SIGINT' ? 2 : 1));
        return;
      }
      resolve(code ?? 0);
    });
  });
}

const CLAUDE_MISSING =
  'error: `claude` not found on PATH. Install Claude Code, ' +
  'or run `active-work open <slug>` to print the prompt.\n';

export function spawnClaude(
  opened: OpenSuccess,
  cwd: string,
  { remoteControl, profile }: LaunchOptions,
  leaseId?: string,
): Promise<number> {
  const { env: profileEnv, warning } = launchProfileEnv(
    process.env,
    { flag: profile, brief: opened.profile },
    (dir) => existsSync(dir),
  );
  if (warning) process.stderr.write(color.yellow(`warning: ${warning}\n`));
  const claudeArgs = buildClaudeArgs(opened.prompt, opened.channels, { remoteControl });
  const child = spawn('claude', claudeArgs, {
    cwd,
    stdio: 'inherit',
    // Explicit env (the default is an implicit `process.env`) so the session
    // can recognize its own lease and not warn about itself.
    env: buildLauncherEnv(profileEnv, leaseId, opened.facet?.name),
  });
  return awaitChild(child, CLAUDE_MISSING);
}
