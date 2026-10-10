import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { accountLabel, type AccountProfile } from "../profile.js";

export const CONFIG_DIRS_ENV = "CLAUDE_CONFIG_DIRS";
// The variable rate-limits.sh reads, so the status line and this scan agree on the root.
export const PROFILE_ROOT_ENV = "CLAUDE_PROFILE_ROOT";
const DEFAULT_DIR_NAME = ".claude";
const PROFILES_DIR_NAME = ".claude-profiles";

export interface DiscoverOptions {
  home?: string;
  env?: Readonly<Record<string, string | undefined>>;
}

function profileFor(configDir: string): AccountProfile {
  return { label: accountLabel(configDir), configDir };
}

// A symlinked entry is skipped, as session-read's scan does, so a link planted in the
// profiles dir cannot point the reader at another user's config.
function isRealDir(dir: string): boolean {
  try {
    return fs.lstatSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function profileDirs(root: string): string[] {
  if (!isRealDir(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name))
    .sort();
}

function fromEnv(value: string): AccountProfile[] {
  return value
    .split(path.delimiter)
    .filter((dir) => dir.length > 0)
    .map(profileFor);
}

// `~/.claude` and every directory under `~/.claude-profiles` (or a non-empty
// CLAUDE_PROFILE_ROOT), in that order. A non-empty CLAUDE_CONFIG_DIRS replaces the scan and
// is taken as given.
export function discoverProfiles(options: DiscoverOptions = {}): AccountProfile[] {
  const env = options.env ?? process.env;
  const override = env[CONFIG_DIRS_ENV];
  if (override !== undefined && override.length > 0) return fromEnv(override);
  const home = options.home ?? os.homedir();
  const defaultDir = path.join(home, DEFAULT_DIR_NAME);
  const dirs = isRealDir(defaultDir) ? [defaultDir] : [];
  const root = env[PROFILE_ROOT_ENV] || path.join(home, PROFILES_DIR_NAME);
  return dirs.concat(profileDirs(root)).map(profileFor);
}
