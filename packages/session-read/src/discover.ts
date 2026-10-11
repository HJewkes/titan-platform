import { promises as fs, lstatSync, readdirSync, statSync, type Dirent } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AccountProfile } from '@titan-design/anthropic-account';
import { CONFIG_DIRS_ENV, discoverProfiles } from '@titan-design/anthropic-account/node';
import { isMissing } from './absent.js';
import { expandHome } from './expand-home.js';

export interface DiscoveredTranscript {
  /** The project directory name Claude Code derives from the session's cwd. */
  projectDir: string;
  absolutePath: string;
  /** `~`-relative form; what gets stored in `transcripts.path`. */
  displayPath: string;
  /**
   * Set when this transcript is a built-in subagent sidechain, which lives at
   * `<project>/<parentSession>/subagents/agent-<agentId>.jsonl`.
   *
   * This is load-bearing, not decorative. Every line in such a file carries a
   * `sessionId` naming its *parent*, so indexing one as an ordinary transcript
   * files the subagent's turns, tokens and file touches under the parent and
   * silently inflates its metrics. The id here is what gives the subagent its
   * own identity instead; `isSidechain` cannot do the job, because 15 of the
   * 557 files in the corpus omit it on some lines. The path never lies.
   */
  subagentId: string | null;
  /** `"default"` for `~/.claude`, the profile directory name otherwise; `null` from `discoverTranscripts(root)` called directly. */
  account: string | null;
  /** The other machine a mirrored transcript was copied from; absent for this machine's own. */
  host?: string;
}

export interface TranscriptRoot {
  root: string;
  account: string;
  /** Set only for a root under a `CLAUDE_TRANSCRIPT_MIRRORS` dir; such a root is a copy, not a config dir to run Claude Code with. */
  host?: string;
}

/**
 * `<host>=<dir>` entries, joined by the path delimiter. Each `<dir>/<account>/projects` is a
 * transcript root labelled with that host. A separate variable rather than an entry in
 * `CLAUDE_CONFIG_DIRS`, which also names the accounts whose credentials and usage get polled.
 */
export const TRANSCRIPT_MIRRORS_ENV = 'CLAUDE_TRANSCRIPT_MIRRORS';

const HOST_LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const DEFAULT_ACCOUNT = 'default';

const SUBAGENT_DIR = 'subagents';
const SUBAGENT_PREFIX = 'agent-';

/** `agent-<id>.jsonl` -> `<id>`; null for anything else in a `subagents/` dir. */
function subagentIdFrom(entry: string): string | null {
  if (!entry.startsWith(SUBAGENT_PREFIX) || !entry.endsWith('.jsonl')) return null;
  const id = entry.slice(SUBAGENT_PREFIX.length, -'.jsonl'.length);
  return id.length > 0 ? id : null;
}

/** Root of Claude Code's per-project transcript store for the default account. */
export function transcriptsRoot(): string {
  return path.join(os.homedir(), '.claude', 'projects');
}

function toDisplayPath(absolutePath: string): string {
  const home = os.homedir();
  return absolutePath.startsWith(`${home}/`) ? `~${absolutePath.slice(home.length)}` : absolutePath;
}

/**
 * Inverse of `toDisplayPath`, for the callers that hold a stored
 * `transcripts.path` and need to touch the file it names.
 */
export function toAbsolutePath(displayPath: string): string {
  return expandHome(displayPath);
}

/**
 * Every `agent-<id>.jsonl` under `<project>/<parentSession>/subagents/`, or an
 * empty list when that session has no subagent directory — which is the common
 * case, so a missing directory is not an error.
 */
async function discoverSubagents(
  root: string,
  projectDir: string,
  sessionDir: string,
): Promise<DiscoveredTranscript[]> {
  const dir = path.join(root, projectDir, sessionDir, SUBAGENT_DIR);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }

  const found: DiscoveredTranscript[] = [];
  for (const entry of entries.sort()) {
    const subagentId = subagentIdFrom(entry);
    if (!subagentId) continue;
    const absolutePath = path.join(dir, entry);
    found.push({
      projectDir,
      absolutePath,
      displayPath: toDisplayPath(absolutePath),
      subagentId,
      account: null,
    });
  }
  return found;
}

/**
 * List every `~/.claude/projects/<project>/<session>.jsonl`, plus every
 * subagent sidechain nested at `<project>/<session>/subagents/agent-<id>.jsonl`,
 * sorted so a full corpus rebuild visits transcripts in a stable order. A
 * directory that disappears mid-walk is skipped rather than aborting the scan.
 */
export async function discoverTranscripts(
  root: string = transcriptsRoot(),
): Promise<DiscoveredTranscript[]> {
  let projectDirs: string[];
  try {
    projectDirs = await fs.readdir(root);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }

  const found: DiscoveredTranscript[] = [];
  for (const projectDir of projectDirs.sort()) {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(path.join(root, projectDir), { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory()) {
        found.push(...(await discoverSubagents(root, projectDir, entry.name)));
        continue;
      }
      if (!entry.name.endsWith('.jsonl')) continue;
      const absolutePath = path.join(root, projectDir, entry.name);
      found.push({
        projectDir,
        absolutePath,
        displayPath: toDisplayPath(absolutePath),
        subagentId: null,
        account: null,
      });
    }
  }
  return found;
}

function rootFor({ configDir, label }: AccountProfile): TranscriptRoot {
  return { root: path.join(configDir, 'projects'), account: label };
}

function hasProjectsDir(configDir: string): boolean {
  try {
    return statSync(path.join(configDir, 'projects')).isDirectory();
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function parseMirror(entry: string): { host: string; dir: string } {
  const split = entry.indexOf('=');
  const host = entry.slice(0, Math.max(split, 0));
  if (!HOST_LABEL.test(host) || split === entry.length - 1) {
    throw new Error(`${TRANSCRIPT_MIRRORS_ENV}: expected <host>=<dir>, got "${entry}"`);
  }
  return { host, dir: expandHome(entry.slice(split + 1)) };
}

function isRealDir(dir: string): boolean {
  try {
    return lstatSync(dir).isDirectory();
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

/** A symlinked account dir is skipped, as the profile scan skips one, so a planted link cannot widen the read. */
function mirrorRoots({ host, dir }: { host: string; dir: string }): TranscriptRoot[] {
  if (!isRealDir(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && hasProjectsDir(path.join(dir, entry.name)))
    .map((entry) => entry.name)
    .sort()
    .map((account) => ({ root: path.join(dir, account, 'projects'), account, host }));
}

function transcriptMirrorRoots(env: NodeJS.ProcessEnv): TranscriptRoot[] {
  const entries = (env[TRANSCRIPT_MIRRORS_ENV] ?? '').split(path.delimiter).filter((entry) => entry.length > 0);
  return entries.map(parseMirror).flatMap(mirrorRoots);
}

/**
 * ~/.claude plus every ~/.claude-profiles/<name> that has a projects dir; CLAUDE_CONFIG_DIRS overrides.
 * Mirrored accounts from `CLAUDE_TRANSCRIPT_MIRRORS` follow either way.
 */
export function claudeTranscriptRoots(env: NodeJS.ProcessEnv = process.env): TranscriptRoot[] {
  return [...localTranscriptRoots(env), ...transcriptMirrorRoots(env)];
}

function localTranscriptRoots(env: NodeJS.ProcessEnv): TranscriptRoot[] {
  const profiles = discoverProfiles({ env });
  if (env[CONFIG_DIRS_ENV]) return profiles.map(rootFor);

  // The default root is listed even when ~/.claude is missing, so a fresh machine still has it.
  const defaultDir = path.join(os.homedir(), '.claude');
  const others = profiles.filter(
    (profile) => profile.configDir !== defaultDir && hasProjectsDir(profile.configDir),
  );
  return [{ root: transcriptsRoot(), account: DEFAULT_ACCOUNT }, ...others.map(rootFor)];
}

/**
 * Discover transcripts across every root `claudeTranscriptRoots` finds,
 * stamping each with the account it came from.
 */
export async function discoverAllTranscripts(
  roots: TranscriptRoot[] = claudeTranscriptRoots(),
): Promise<DiscoveredTranscript[]> {
  const found: DiscoveredTranscript[] = [];
  for (const { root, account, host } of roots) {
    const transcripts = await discoverTranscripts(root);
    found.push(...transcripts.map((transcript) => ({ ...transcript, account, ...(host ? { host } : {}) })));
  }
  return found;
}
