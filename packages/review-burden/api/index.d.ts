/** A changed file's status, in GitHub's pull request files vocabulary; a `git --name-status` reader maps `D` to `removed`. */
type FileStatus = "added" | "modified" | "removed" | "renamed" | "copied";
/** One file of the diff between the merge base and head, with its numstat line counts. */
interface ChangedFile {
    path: string;
    /** The base-side path of a rename or copy. */
    previousPath?: string;
    status: FileStatus;
    additions: number;
    deletions: number;
}
/** One changed `package.json`, parsed on each side; a side is absent when the file does not exist there. */
interface PackageJsonChange {
    path: string;
    base?: Record<string, unknown>;
    head?: Record<string, unknown>;
}
/** The repo-specific globs every rule reads; all are repo-relative POSIX globs with `**`, `*`, `?` and `{a,b}`. */
interface BurdenConfig {
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
declare const DEFAULT_BURDEN_CONFIG: Readonly<BurdenConfig>;
/** The defaults with each given key replacing, not extending, its default list. */
declare function resolveConfig(config?: Partial<BurdenConfig>): BurdenConfig;

type PathClass = "test" | "ignored" | "production";
/** A classifier compiled once for a whole diff; test globs win over ignored ones, so a fixture `.md` is test material. */
declare function pathClassifier(config?: Partial<BurdenConfig>): (path: string) => PathClass;
declare function classifyPath(path: string, config?: Partial<BurdenConfig>): PathClass;

type Door = "one-way" | "two-way";
declare const FOOTER_MARKER = "<!-- merge-danger:v1 -->";
/** The author's declared merge-danger footer; a key is absent when its line is missing or empty. */
interface Footer {
    door?: Door;
    blastRadius?: string;
    rollback?: string;
    contract?: string;
    /** True only when all four keys are present and the door is `one-way` or `two-way`. */
    present: boolean;
}
/** Reads the four keys after the last marker, so an edited body's newest footer counts; the first non-empty line per key wins. */
declare function parseFooter(body: string): Footer;
/** True when the footer names a contract; `none`, in any case, means it does not. */
declare function hasContract(footer: Footer): boolean;

type ChangesetBump = "major" | "minor" | "patch";
type OneWayFactKind = "migration" | "major-changeset" | "authority-path" | "package-key-removed" | "stored-data-deleted";
/** One reason a revert would not restore the old behaviour; `path` and `detail` name what to look at. */
interface OneWayFact {
    kind: OneWayFactKind;
    path?: string;
    detail?: string;
}
interface DoorInput {
    files: readonly ChangedFile[];
    /** Every bump the PR's changesets declare, one entry per package line. */
    changesetBumps?: readonly ChangesetBump[];
    packageJsons?: readonly PackageJsonChange[];
    config?: Partial<BurdenConfig>;
}
interface DoorFacts {
    door: Door;
    facts: OneWayFact[];
}
/** The computed door: one-way when any fact holds, each fact listed in a fixed order. */
declare function doorFacts(input: DoorInput): DoorFacts;
/** The stricter of the declared and computed doors; a missing declaration defers to the facts. */
declare function effectiveDoor(declared: Door | undefined, computed: Door): Door;
/** True when the author declared two-way and a fact makes the PR one-way. */
declare function underDeclared(declared: Door | undefined, computed: Door): boolean;

declare const MAX_BURDEN = 100;
interface BurdenInput {
    files: readonly ChangedFile[];
    /** `.codewatch/check.json` `$tiers`: tier name to unit directories; absent in a repo with no tier map. */
    tiers?: Readonly<Record<string, readonly string[]>>;
    packageJsons?: readonly PackageJsonChange[];
    body: string;
    config?: Partial<BurdenConfig>;
}
/** The derived inputs each part reads, so a reader can see why a part scored what it did. */
interface BurdenFacts {
    productionLines: number;
    testLines: number;
    productionFiles: number;
    units: string[];
    /** The lowest numeric tier a production file touched; absent when none is mapped. */
    tier?: number;
    api: boolean;
    migration: boolean;
    runtimeDeps: number;
    devDeps: number;
    footer: boolean;
    contract: boolean;
}
interface BurdenParts {
    size: number;
    spread: number;
    tests: number;
    tier: number;
    api: number;
    migration: number;
    deps: number;
    rationale: number;
    contract: number;
}
interface BurdenScore {
    total: number;
    parts: BurdenParts;
    facts: BurdenFacts;
}
/** The 0 to 100 review burden: each part from its own row, summed and capped. Same input, same score. */
declare function burdenScore(input: BurdenInput): BurdenScore;
declare function burdenFacts(input: BurdenInput): BurdenFacts;
declare function scoreParts(facts: BurdenFacts): BurdenParts;
/**
 * The unit a path belongs to: `packages/x`, `products/x` or `apps/x`, then `src/<dir>` for a
 * single-package repo, else the top-level directory. A root file is repo-wide config and joins no unit.
 */
declare function unitOf(file: ChangedFile): string[];

export { type BurdenConfig, type BurdenFacts, type BurdenInput, type BurdenParts, type BurdenScore, type ChangedFile, type ChangesetBump, DEFAULT_BURDEN_CONFIG, type Door, type DoorFacts, type DoorInput, FOOTER_MARKER, type FileStatus, type Footer, MAX_BURDEN, type OneWayFact, type OneWayFactKind, type PackageJsonChange, type PathClass, burdenFacts, burdenScore, classifyPath, doorFacts, effectiveDoor, hasContract, parseFooter, pathClassifier, resolveConfig, scoreParts, underDeclared, unitOf };
