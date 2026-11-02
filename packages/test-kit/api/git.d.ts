/** Files committed by the seed commit, keyed by path relative to the repository root. */
type SeedFiles = Readonly<Record<string, string>>;
/** One commit `withHistory` writes. A `null` file deletes that path. */
interface HistoryCommit {
    readonly files: Readonly<Record<string, string | null>>;
    readonly message?: string;
    /** The branch the commit lands on; `main` when left out. */
    readonly branch?: string;
    /**
     * The parent: a branch, `:n` for this history's nth commit (from 1), or a full sha. Left out, a commit follows its
     * branch's last commit, or the branch's tip in the repository, or has no parent when the branch does not exist yet.
     */
    readonly from?: string;
    /** When the commit was made, as `Date.parse` reads it; left out, the pinned date `withHistory` gives its position. */
    readonly date?: string;
    /** The author's name, with the email `<name>@example.com`; left out, the fixture identity authors the commit. */
    readonly author?: string;
}
/**
 * The environment for fixture git commands: no system or global config, a fixed identity, and none of the
 * `GIT_CONFIG_*` entries a session may inject (such as a `core.hooksPath` whose push hook refuses scratch remotes).
 */
declare function fixtureEnv(): NodeJS.ProcessEnv;
/** Runs git in `cwd` under `fixtureEnv`, returning trimmed stdout; a non-zero exit throws with stderr on the error. */
declare function gitIn(cwd: string): (...args: string[]) => string;
/** The directory holding this test file's templates, or undefined before the first seed. */
declare function templateDirectory(): string | undefined;
/** Deletes every template built so far; the next seed builds them again. */
declare function removeTemplates(): void;
/**
 * Fills the empty or missing directory `dir` with a repository on `main` holding one seed commit of `files`, and no
 * remote. Empty `files` leave `main` unborn. Each file builds one template per seed and copies it, so a test may
 * change the copy's config, refs and history freely.
 */
declare function seedRepo(dir: string, files?: SeedFiles): void;
/** The same, with `origin` (an empty or missing directory) made the bare remote that already holds the seed commit. */
declare function seedRepoWithOrigin(dir: string, origin: string, files?: SeedFiles): void;
/**
 * Writes `commits` into the repository at `dir` with one `git fast-import`, then checks out the last commit's branch
 * with its tree. Returns each commit's sha, in order. Commit dates are pinned unless a commit names its own, so a
 * history's shas are the same on every run; files are written as mode 100644.
 */
declare function withHistory(dir: string, commits: readonly HistoryCommit[]): string[];

export { type HistoryCommit, type SeedFiles, fixtureEnv, gitIn, removeTemplates, seedRepo, seedRepoWithOrigin, templateDirectory, withHistory };
