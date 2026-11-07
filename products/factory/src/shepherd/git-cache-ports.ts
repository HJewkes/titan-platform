// Types only, so a deps type can name the ports without joining tree-carry's import cycle.

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs git against one bare repository; resolves with the exit code instead of rejecting. */
export type Git = (gitDir: string, args: readonly string[], signal?: AbortSignal) => Promise<GitResult>;

export interface CacheFs {
  exists(path: string): boolean;
  mkdirp(dir: string): void;
}

/** The host effects a cache read needs; `stateDir` is a thunk read on every probe, never once when the ports are built. */
export interface GitCachePorts {
  git: Git;
  fs: CacheFs;
  stateDir: () => string;
}
