import { promises as fs, readdirSync, statSync, type Dirent } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
}

export interface TranscriptRoot {
  root: string;
  account: string;
}

const DEFAULT_ACCOUNT = 'default';
const PROFILES_DIR_NAME = '.claude-profiles';
const CONFIG_DIRS_ENV = 'CLAUDE_CONFIG_DIRS';

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
  return displayPath.startsWith('~/') ? path.join(os.homedir(), displayPath.slice(2)) : displayPath;
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
  } catch {
    return [];
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
  } catch {
    return [];
  }

  const found: DiscoveredTranscript[] = [];
  for (const projectDir of projectDirs.sort()) {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(path.join(root, projectDir), { withFileTypes: true });
    } catch {
      continue;
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

function accountFor(configDir: string): string {
  const name = path.basename(configDir);
  return name === '.claude' ? DEFAULT_ACCOUNT : name;
}

function rootFor(configDir: string): TranscriptRoot {
  return { root: path.join(configDir, 'projects'), account: accountFor(configDir) };
}

function hasProjectsDir(configDir: string): boolean {
  try {
    return statSync(path.join(configDir, 'projects')).isDirectory();
  } catch {
    return false;
  }
}

/** ~/.claude plus every ~/.claude-profiles/<name> that has a projects dir; CLAUDE_CONFIG_DIRS overrides. */
export function claudeTranscriptRoots(env: NodeJS.ProcessEnv = process.env): TranscriptRoot[] {
  const override = env[CONFIG_DIRS_ENV];
  if (override) {
    return override
      .split(path.delimiter)
      .filter((dir) => dir.length > 0)
      .map(rootFor);
  }

  const home = os.homedir();
  const roots: TranscriptRoot[] = [{ root: transcriptsRoot(), account: DEFAULT_ACCOUNT }];

  let profiles: string[];
  try {
    profiles = readdirSync(path.join(home, PROFILES_DIR_NAME), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return roots;
  }

  for (const profile of profiles) {
    const configDir = path.join(home, PROFILES_DIR_NAME, profile);
    if (hasProjectsDir(configDir)) roots.push(rootFor(configDir));
  }
  return roots;
}

/**
 * Discover transcripts across every root `claudeTranscriptRoots` finds,
 * stamping each with the account it came from.
 */
export async function discoverAllTranscripts(
  roots: TranscriptRoot[] = claudeTranscriptRoots(),
): Promise<DiscoveredTranscript[]> {
  const found: DiscoveredTranscript[] = [];
  for (const { root, account } of roots) {
    const transcripts = await discoverTranscripts(root);
    found.push(...transcripts.map((transcript) => ({ ...transcript, account })));
  }
  return found;
}
