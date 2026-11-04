import type { IsolationName } from "../profiles/schema.js";
import { fileOwnershipStrategy } from "./file-ownership.js";
import { noneStrategy } from "./none.js";
import { composite, type IsolationStrategy } from "./strategy.js";
import { toolsetStrategy } from "./toolset.js";

export interface IsolationRegistryOptions {
  /** The worktree strategy reads the host's budgets, so the host builds it and hands it in. */
  worktree: IsolationStrategy;
}

export interface IsolationRegistry {
  getStrategy(name: IsolationName): IsolationStrategy;
  /**
   * Compose strategies into one. A profile names exactly one today, but the
   * composite means `['toolset-limited', 'worktree']` stays a config change rather
   * than a refactor. Do not reintroduce the single-strategy assumption into a
   * caller: call this even for one name.
   */
  resolve(names: readonly IsolationName[]): IsolationStrategy;
}

/** One registry per host, rather than a module singleton, because the worktree strategy carries host budget readers. */
export function createIsolationRegistry(options: IsolationRegistryOptions): IsolationRegistry {
  const strategies: Record<IsolationName, IsolationStrategy> = {
    none: noneStrategy,
    worktree: options.worktree,
    "file-ownership": fileOwnershipStrategy,
    "toolset-limited": toolsetStrategy,
  };
  const getStrategy = (name: IsolationName): IsolationStrategy => strategies[name];
  return {
    getStrategy,
    resolve(names) {
      if (names.length === 0) return noneStrategy;
      const only = names.length === 1 ? names[0] : undefined;
      if (only !== undefined) return getStrategy(only);
      return composite(names.map(getStrategy));
    },
  };
}
