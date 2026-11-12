import type { ChildProcess, spawn } from 'node:child_process';

function isSpawn(value: unknown): value is typeof spawn {
  return typeof value === 'function';
}

function isChild(value: unknown): value is ChildProcess {
  return typeof value === 'object' && value !== null && typeof Reflect.get(value, 'on') === 'function';
}

/**
 * Hand a structural spawn fake to code that wants `child_process.spawn`, without a cast.
 * The child it returns must have `on`, the member the code under test subscribes with.
 */
export function asSpawn(fake: unknown): typeof spawn {
  if (!isSpawn(fake)) throw new Error('a spawn fake must be a function');
  const checked = (...args: unknown[]): ChildProcess => {
    const child: unknown = Reflect.apply(fake, undefined, args);
    if (!isChild(child)) throw new Error('a spawn fake must return a child with an `on` method');
    return child;
  };
  if (!isSpawn(checked)) throw new Error('unreachable: a function is always a spawn');
  return checked;
}
