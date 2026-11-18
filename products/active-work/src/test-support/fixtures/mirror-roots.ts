import path from 'node:path';
import { TRANSCRIPT_MIRRORS_ENV } from '@titan-design/session-read';
import { vi } from 'vitest';

/** A read-only copy of another machine's transcripts, as `CLAUDE_TRANSCRIPT_MIRRORS` names one. */
export interface MirrorRoot {
  root: string;
  account: string;
  host: string;
}

/** `<dir>/<account>/projects`, the layout a mirror dir holds per account. */
export function mirrorRoot(dir: string, account: string, host = 'mac'): MirrorRoot {
  return { root: path.join(dir, account, 'projects'), account, host };
}

/** Names `dir` as a mirror of `host` through `CLAUDE_TRANSCRIPT_MIRRORS`; pair with `vi.unstubAllEnvs()` in `afterEach`. */
export function useMirror(dir: string, host = 'mac'): void {
  const existing = process.env[TRANSCRIPT_MIRRORS_ENV];
  const entry = `${host}=${dir}`;
  vi.stubEnv(TRANSCRIPT_MIRRORS_ENV, existing ? `${existing}${path.delimiter}${entry}` : entry);
}
