import { afterAll } from "vitest";
import { removeFixture, type FixtureRepo } from "./fake-ports.js";
import type { TestHost } from "./host.js";

/** The lists a test file's afterEach empties: a shared run's host and repo are taken out of them. */
interface Owned {
  hosts: TestHost[];
  repos: FixtureRepo[];
}

const keyOf = (args: readonly unknown[]) => JSON.stringify(args, (_key, value: unknown) => (typeof value === "function" ? value.name : value));

/**
 * `loop` run once per distinct arguments, for tests that only read the finished run; a function argument is keyed by
 * its name. Its host and repo outlive afterEach and are released after the file.
 */
export function sharedRuns<A extends unknown[], R>(loop: (...args: A) => Promise<R>, owned: Owned): (...args: A) => Promise<R> {
  const runs = new Map<string, Promise<R>>();
  const kept: Owned = { hosts: [], repos: [] };
  afterAll(() => {
    kept.hosts.splice(0).forEach((host) => host.close());
    kept.repos.splice(0).forEach(removeFixture);
  });
  return async (...args) => {
    const key = keyOf(args);
    if (!runs.has(key)) {
      const [hosts, repos] = [owned.hosts.length, owned.repos.length];
      runs.set(key, loop(...args));
      await runs.get(key);
      kept.hosts.push(...owned.hosts.splice(hosts));
      kept.repos.push(...owned.repos.splice(repos));
    }
    return runs.get(key)!;
  };
}
