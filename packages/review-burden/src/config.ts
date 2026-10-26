/** A changed file's status, in GitHub's pull request files vocabulary; a `git --name-status` reader maps `D` to `removed`. */
export type FileStatus = "added" | "modified" | "removed" | "renamed" | "copied";

/** One file of the diff between the merge base and head, with its numstat line counts. */
export interface ChangedFile {
  path: string;
  /** The base-side path of a rename or copy. */
  previousPath?: string;
  status: FileStatus;
  additions: number;
  deletions: number;
}

/** One changed `package.json`, parsed on each side; a side is absent when the file does not exist there. */
export interface PackageJsonChange {
  path: string;
  base?: Record<string, unknown>;
  head?: Record<string, unknown>;
}

/** The repo-specific globs every rule reads; all are repo-relative POSIX globs with `**`, `*`, `?` and `{a,b}`. */
export interface BurdenConfig {
  testGlobs: string[];
  ignoredGlobs: string[];
  /** Generated files the repo lists on top of `ignoredGlobs`, such as a capability index. */
  generatedGlobs: string[];
  migrationGlobs: string[];
  /** Paths that change a public surface even when they are tests, such as a CLI help golden. */
  apiGlobs: string[];
  /** Paths whose deletion breaks stored data or a wire contract. */
  storedDataGlobs: string[];
  /** Paths the authority table protects; the caller passes them so this package imports no policy. */
  protectedPaths: string[];
}

export const DEFAULT_BURDEN_CONFIG: Readonly<BurdenConfig> = Object.freeze({
  testGlobs: ["**/*.test.*", "**/*.spec.*", "**/__tests__/**", "**/__fixtures__/**", "**/golden/**"],
  ignoredGlobs: [
    "**/pnpm-lock.yaml",
    "**/package-lock.json",
    "**/yarn.lock",
    "**/bun.lock{,b}",
    ".changeset/**",
    "**/*.md",
  ],
  generatedGlobs: [],
  migrationGlobs: ["**/migrations/**", "**/*migration*.{ts,sql}"],
  apiGlobs: ["**/src/index.ts", "**/golden/**/*help*", "**/*tool-names*"],
  storedDataGlobs: [],
  protectedPaths: [],
});

/** The defaults with each given key replacing, not extending, its default list. */
export function resolveConfig(config: Partial<BurdenConfig> = {}): BurdenConfig {
  return { ...DEFAULT_BURDEN_CONFIG, ...config };
}
