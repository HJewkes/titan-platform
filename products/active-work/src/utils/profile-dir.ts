import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';

export const PROFILE_ROOT_ENV = 'CLAUDE_PROFILE_ROOT';

/** Matches the default used by the `claude-profile` shell function. */
const DEFAULT_PROFILE_ROOT = '.claude-profiles';

export function profileRoot(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env[PROFILE_ROOT_ENV];
  if (configured && isAbsolute(configured)) return configured;
  return join(homedir(), DEFAULT_PROFILE_ROOT);
}

export function resolveProfileDir(profile: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(profileRoot(env), profile);
}
