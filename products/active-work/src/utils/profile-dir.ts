import { join } from 'node:path';
import { profilesRoot } from '@titan-design/anthropic-account/node';

export function resolveProfileDir(profile: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(profilesRoot(env), profile);
}
