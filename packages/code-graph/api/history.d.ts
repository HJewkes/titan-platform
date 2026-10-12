import { H as HistoryLoad, C as ChurnEntry, a as ChurnWindow } from '../change-coupling.js';
export { b as ChangeCouplingResult, c as CoEditPair, d as ComputeChangeCouplingOptions, e as CouplingPartner, G as GitHistoryError, f as GitLargeFailure, L as LoadChurnOptions, g as computeChangeCoupling, h as couplingFor, i as entriesWithin, l as loadChurnEntries, j as loadChurnResult, p as parseChurnLog, r as resolveRenamedPath } from '../change-coupling.js';

/** A regular file or symlink in a commit's tree: its repo-relative path and blob id. */
interface TreeBlob {
    path: string;
    oid: string;
    /** A symlink (mode 120000): the blob holds the link's target. */
    link: boolean;
}
interface ResolvedCommit {
    commit: string;
    /** Committer time, seconds since the epoch. */
    commitEpoch: number;
}
/** Resolve `rev` to a commit sha and its committer epoch; throws naming `rev` when it is not a commit. */
declare function resolveCommit(repoRoot: string, rev: string): ResolvedCommit;
/** Every regular file and symlink in `commit`'s tree, via `git ls-tree -r -z`. */
declare function listTreeBlobs(repoRoot: string, commit: string): TreeBlob[];
/** UTF-8 content of each blob in `oids`, read with a single `git cat-file --batch`. */
declare function readBlobs(repoRoot: string, oids: readonly string[]): Map<string, string>;

interface FirstSeenOptions {
    /** Directory paths are made relative to; paths outside it are dropped. */
    repoRoot: string;
    knownPaths?: ReadonlySet<string>;
    /** Walk history from this rev instead of HEAD. */
    rev?: string;
}
/**
 * Earliest commit time (epoch seconds) per path, from one reverse-ordered pass
 * over full history up to `rev` (default HEAD): the first commit that touched a path approximates its birth.
 * Rebased onto `repoRoot` and filtered to `knownPaths` when given. Renames slightly
 * underestimate age (pre-rename history lives under the old path). Returns null
 * when `repoRoot` is not a git checkout or git is missing, so callers degrade to "no age discount".
 * Throws a `GitHistoryError` when the log overflowed or git failed; use {@link loadFirstSeenResult}
 * to branch on the outcome instead.
 */
declare function loadFileFirstSeen(options: FirstSeenOptions): Map<string, number> | null;
/** {@link loadFileFirstSeen} with the failure kind (`not-git`, `overflow`, `git-error`) kept apart. */
declare function loadFirstSeenResult(options: FirstSeenOptions): HistoryLoad<Map<string, number>>;

/** One path's churn over a set of entries. */
interface PathChurn {
    /** Lines added plus lines deleted. */
    lines: number;
    /** Distinct commits that touched the path. */
    commits: number;
    /** Distinct author identities that touched the path. */
    authors: number;
}
/** Per-path churn, in first-touched order, filtered to `knownPaths` when given. */
declare function aggregateChurn(entries: readonly ChurnEntry[], knownPaths?: ReadonlySet<string>): Map<string, PathChurn>;
/**
 * Churn for several windows from one wide log: slice `entries` by commit time
 * per window and aggregate each slice independently, so 30/90/180-day churn can
 * be stored side by side from a single git pass.
 */
declare function aggregateChurnWindows(entries: readonly ChurnEntry[], windowsDays: readonly ChurnWindow[], nowEpoch: number, knownPaths?: ReadonlySet<string>): Map<ChurnWindow, Map<string, PathChurn>>;

interface OwnershipForFile {
    /** Distinct contributing authors. */
    authors: number;
    /** Fraction of churn (lines) from the single largest contributor (0..1), unrounded. */
    topAuthorShare: number;
    /** Min number of authors whose combined contribution covers >= the threshold of churn. */
    busFactor: number;
}
interface ComputeOwnershipOptions {
    knownPaths?: ReadonlySet<string>;
    /** Coverage threshold for busFactor (default 0.5 = 50% of churn). */
    busFactorThreshold?: number;
}
/** Ownership per path with non-zero churn, keyed by repo-relative path. */
declare function computeOwnership(entries: readonly ChurnEntry[], options?: ComputeOwnershipOptions): Map<string, OwnershipForFile>;
/** Lines changed per author per path, skipping zero-line entries (binary files). */
declare function authorLinesByPath(entries: readonly ChurnEntry[], known: ReadonlySet<string> | undefined): Map<string, Map<string, number>>;
/** Summarize one author tally; null when it holds no churn. */
declare function summarizeOwnership(byAuthor: ReadonlyMap<string, number>, threshold?: number): OwnershipForFile | null;

/** Task ids such as `TP-2474` or `CC-44`, read from commit subjects. */
declare const DEFAULT_TASK_ID_PATTERN: RegExp;
/** A commit's edit to one file, with its hunks' new-side lines already carried forward to HEAD. */
interface FileEdit {
    commit: string;
    epoch: number;
    taskIds: readonly string[];
    /** Repo-relative path at HEAD (after later renames), rebased onto the caller's root. */
    filePath: string;
    /** Inclusive 1-based line ranges in HEAD coordinates. */
    ranges: readonly [number, number][];
}
interface LoadFileEditsOptions {
    repoRoot: string;
    windowDays: number;
    rev?: string;
    untilEpoch?: number;
    taskIdPattern?: RegExp;
}
/** Every in-window commit's per-file edits, newest first, with line ranges expressed against HEAD. */
declare function loadFileEditsResult(options: LoadFileEditsOptions): HistoryLoad<FileEdit[]>;
/** A symbol's HEAD line span, for attributing edits. */
interface SymbolSpan {
    id: string;
    startLine: number;
    endLine: number;
}
/** Distinct task ids and commits that edited one symbol. */
interface SymbolAccretion {
    taskIds: Set<string>;
    commits: Set<string>;
}
/**
 * Credit each edit to the innermost symbols its ranges overlap, so a method edit counts for the
 * method and not again for its class. Keyed by symbol id; symbols nobody edited are absent.
 */
declare function accreteSymbols(edits: readonly FileEdit[], spansByFile: ReadonlyMap<string, readonly SymbolSpan[]>): Map<string, SymbolAccretion>;

export { ChurnEntry, ChurnWindow, type ComputeOwnershipOptions, DEFAULT_TASK_ID_PATTERN, type FileEdit, type FirstSeenOptions, HistoryLoad, type OwnershipForFile, type PathChurn, type ResolvedCommit, type SymbolAccretion, type SymbolSpan, type TreeBlob, accreteSymbols, aggregateChurn, aggregateChurnWindows, authorLinesByPath, computeOwnership, listTreeBlobs, loadFileEditsResult, loadFileFirstSeen, loadFirstSeenResult, readBlobs, resolveCommit, summarizeOwnership };

// ./dist/change-coupling.d.ts
/**
 * A churn window is either a rolling N-day window or `"lifetime"` = all of git
 * history (no `--since` bound). Lifetime mode lets an unfamiliar repo be audited
 * cold, where any recent rolling slice is thin relative to the repo's whole
 * life, so a windowed view reads an established repo as nearly churn-free.
 */
type ChurnWindow = number | "lifetime";

declare function detectGitToplevel(cwd: string): string | null;
type GitLargeFailure = "not-git" | "overflow" | "git-error";
/** A history load that is neither a success nor a plain "not a git checkout". */
declare class GitHistoryError extends Error {
    readonly reason: Exclude<GitLargeFailure, "not-git">;
    readonly detail: string;
    constructor(reason: Exclude<GitLargeFailure, "not-git">, detail: string);
}
type HistoryLoad<T> = {
    ok: true;
    value: T;
} | {
    ok: false;
    reason: GitLargeFailure;
    detail: string;
};

interface ChurnEntry {
    commit: string;
    /** Author identity: git author email (%ae), stable across name spelling drift. */
    author: string;
    /** Committer time (%ct), epoch seconds; lets one wide log be sliced per window. */
    epoch: number;
    /** Repo-relative posix path, rebased onto the caller's root. */
    filePath: string;
    added: number;
    deleted: number;
}
interface LoadChurnOptions {
    /** Directory paths are made relative to; entries outside it are dropped. */
    repoRoot: string;
    windowDays?: ChurnWindow;
    /** Walk history from this rev instead of HEAD. */
    rev?: string;
    /** Epoch seconds a finite window ends at; defaults to the wall clock. */
    untilEpoch?: number;
}
/**
 * Parse the last `windowDays` of git history up to `rev` (default HEAD) into ChurnEntry[] rebased onto
 * `repoRoot`. Returns null when `repoRoot` is not a git checkout or git is missing; [] if no commits matched.
 * Throws a `GitHistoryError` when git ran but failed or its log overflowed the buffer, because the
 * history exists and a null would silently pass for "no history". Use {@link loadChurnResult} to branch
 * on the outcome instead. Used both for churn metrics and for change-coupling.
 */
declare function loadChurnEntries(options: LoadChurnOptions): ChurnEntry[] | null;
/** {@link loadChurnEntries} with the failure kind (`not-git`, `overflow`, `git-error`) kept apart. */
declare function loadChurnResult(options: LoadChurnOptions): HistoryLoad<ChurnEntry[]>;
declare function parseChurnLog(text: string): ChurnEntry[];
declare function resolveRenamedPath(rawPath: string): string;
/** Entries whose commit landed within the last `windowDays` of `nowEpoch`. */
declare function entriesWithin(entries: readonly ChurnEntry[], windowDays: number, nowEpoch: number): ChurnEntry[];

interface CoEditPair {
    fileA: string;
    fileB: string;
    /** Commits in which both files changed. */
    count: number;
    /** Most recent commits (up to maxCommitsPerPair). */
    commits: string[];
}
interface ComputeChangeCouplingOptions {
    /** Skip pairs that co-occur in fewer than this many commits. Default 2. */
    minCount?: number;
    /** Truncate the commits sample per pair. Default 10. */
    maxCommitsPerPair?: number;
    /**
     * Skip commits touching more than this many files (sweeping refactors, mass
     * renames). Default 50: beyond that the O(n²) pair explosion is signal-poor.
     */
    largeCommitThreshold?: number;
    /** Filter file paths to this set before pairing. */
    knownPaths?: ReadonlySet<string>;
}
interface ChangeCouplingResult {
    pairs: CoEditPair[];
    /** Commits dropped by largeCommitThreshold, so callers can say when sweeps suppressed the signal. */
    skippedLargeCommits: number;
    /** Threshold that was applied (echoed for diagnostic messages). */
    largeCommitThreshold: number;
}
interface CouplingPartner {
    partner: string;
    count: number;
    commits: string[];
}
declare function computeChangeCoupling(entries: readonly ChurnEntry[], options?: ComputeChangeCouplingOptions): ChangeCouplingResult;
/** Files most coupled to `seed`, by co-edit count desc then path; the seed itself is excluded. */
declare function couplingFor(pairs: readonly CoEditPair[], seed: string): CouplingPartner[];

export { type ChurnEntry as C, GitHistoryError as G, type HistoryLoad as H, type LoadChurnOptions as L, type ChurnWindow as a, type ChangeCouplingResult as b, type CoEditPair as c, type ComputeChangeCouplingOptions as d, type CouplingPartner as e, type GitLargeFailure as f, computeChangeCoupling as g, couplingFor as h, entriesWithin as i, loadChurnResult as j, detectGitToplevel as k, loadChurnEntries as l, parseChurnLog as p, resolveRenamedPath as r };
