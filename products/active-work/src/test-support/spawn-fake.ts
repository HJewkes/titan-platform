import type { spawn } from 'node:child_process';

function isSpawn(value: unknown): value is typeof spawn {
  return typeof value === 'function';
}

/** Hand a structural spawn fake to code that wants `child_process.spawn`, without a cast. */
export function asSpawn(fake: unknown): typeof spawn {
  if (!isSpawn(fake)) throw new Error('a spawn fake must be a function');
  return fake;
}
