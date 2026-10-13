import { Octokit } from '@octokit/core';

/** The only conclusions an App-posted check run may carry. */
declare const CHECK_CONCLUSIONS: readonly ["success", "failure", "action_required"];
type CheckConclusion = (typeof CHECK_CONCLUSIONS)[number];
interface CreateCheckRunRequest {
    name: string;
    headSha: string;
    /** Typed narrowly, and checked again at runtime because callers cross a JSON boundary. */
    conclusion: CheckConclusion;
    title: string;
    summary: string;
    externalId: string;
}

/** Below this many remaining calls of a resource, every call waits its share of the time left until reset. */
declare const RATE_FLOOR = 500;
/** One budget per GitHub login: every wire that shares it paces against the same remaining count. */
interface RateBudget {
    /** Resolves when a call to `resource` may go out; GraphQL has its own quota, apart from core. */
    acquire(resource?: BudgetResource): Promise<void>;
    /** Reads `x-ratelimit-*` from a response's lower-cased headers; resources other than core and graphql are ignored. */
    observe(headers: ReadonlyMap<string, string>): void;
    readonly remaining: number | null;
}
type BudgetResource = "core" | "graphql";
interface RateBudgetOptions {
    floor?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
}
declare function rateBudget(options?: RateBudgetOptions): RateBudget;
/** Spreads the calls left over the time left, so a low budget slows callers instead of exhausting them. */
declare function backoffMs(remaining: number | null, resetAtMs: number, floor: number, nowMs: number): number;
/** The default for every `ghCliWire` in this process, because GitHub counts calls per login, not per wire. */
declare const sharedRateBudget: RateBudget;

interface GhResult {
    code: number;
    stdout: string;
    stderr: string;
}
/** Runs `gh` with an argv array and optional stdin; never through a shell. */
type GhExec = (args: readonly string[], input?: string, options?: GhExecOptions) => Promise<GhResult>;
interface GhExecOptions {
    /** Kills the child with SIGKILL and rejects once this many milliseconds pass. */
    timeoutMs?: number;
    /** Caps stdout and stderr each, in bytes; defaults to 32 MiB. Exceeding it rejects. */
    maxBufferBytes?: number;
    /** Extra child environment for this one call, merged over `process.env`; never written to `process.env` or argv. */
    env?: Readonly<Record<string, string>>;
}
declare class GhError extends Error {
    readonly args: readonly string[];
    readonly result: GhResult;
    private readonly httpStatus?;
    constructor(args: readonly string[], result: GhResult, httpStatus?: number | undefined);
    get status(): number | undefined;
}
/** Uses the caller's existing `gh` login; this module never sees a token. */
declare const execGh: GhExec;

type Fields = Record<string, string>;
/** A GET sent with the caller's own ETag: a 304 answers `notModified`, with no body and, on GitHub, no rate-limit point. */
type Revalidated<T> = {
    notModified: true;
} | {
    notModified: false;
    body: T;
    etag: string | null;
};
/** The REST transport every wire method reads through: `restCaller` over `gh api -i`, or `octokitRest` over Octokit. */
interface Rest {
    /** Conditional on the ETag of the same request's last 200; a 304 answers with that cached body. */
    get<T>(path: string, fields?: Fields): Promise<T>;
    getOrNull<T>(path: string, fields?: Fields): Promise<T | null>;
    /** Follows `Link: rel="next"`, each page conditional on its own ETag. */
    pages<P, T>(path: string, fields: Fields, pick: (page: P) => T[]): Promise<T[]>;
    /**
     * Like `pages`, but conditional on the caller's `etag` rather than the cache. One ETag vouches for one page, so a list
     * longer than a page answers every page with a null `etag`, and the caller's next read is unconditional.
     */
    revalidatePages<P, T>(path: string, fields: Fields, etag: string | null, pick: (page: P) => T[]): Promise<Revalidated<T[]>>;
    /** Unconditional, for bodies that are not JSON. */
    text(path: string): Promise<string>;
    send<T>(method: "POST" | "PUT" | "PATCH" | "DELETE", path: string, fields?: Fields, input?: string): Promise<T>;
}

/** One force-push of a PR's head branch: the head it replaced, null once GitHub no longer has that commit, and the new head. */
interface ForcePush {
    before: string | null;
    after: string | null;
}
/** What the wire read: the first `FORCE_PUSHES_CAP` pushes, oldest first, and whether more exist past them. */
interface ForcePushPage {
    pushes: ForcePush[];
    more: boolean;
}
/** One GraphQL page; the port reads no further. */
declare const FORCE_PUSHES_CAP = 100;
/** Named so a caller that reports only an error's class still says the list was cut short. */
declare class ForcePushesTruncated extends Error {
    constructor();
}

/**
 * The open PRs, or `notModified` when they are unchanged since the read that answered `etag`. Rows carry no `behind`
 * and an `unknown` mergeable state, like every list row, and a change to either does not change the ETag.
 */
type OpenPrList = {
    notModified: true;
} | {
    notModified: false;
    prs: PullRequest[];
    etag: string | null;
};
interface OpenPrRequest {
    head: string;
    base: string;
    title: string;
    body: string;
}

/** One inline review comment; a comment is resolved when its review thread is. */
interface ReviewComment {
    id: number;
    /** Login of the reviewer; empty for a deleted account. */
    author: string;
    /** GitHub's relation of the author to the repo: OWNER, MEMBER, COLLABORATOR, CONTRIBUTOR, NONE and so on. Anyone can comment on a public repo. */
    authorAssociation: string;
    path: string;
    /** The line in the head's version of `path`; null when the comment is outdated or on the whole file. */
    line: number | null;
    body: string;
    resolved: boolean;
}

interface Commit {
    sha: string;
    parents: string[];
    /** The tree the commit records; absent when the wire does not report it. */
    tree?: string;
    /** The committer date; for a commit GitHub made on merge, when it landed. Absent when the wire does not report it. */
    committedAt?: string;
    /** The full commit message; absent when the wire does not report it. */
    message?: string;
}
/** The newest commit status per context on a sha, as the combined status endpoint reports it. */
interface CommitStatus {
    context: string;
    /** `success`, `pending`, `failure` or `error`. */
    state: string;
}
/** A commit on the default branch with its full message, subject line first. */
interface LoggedCommit {
    sha: string;
    message: string;
}
interface RepoFile {
    path: string;
    blobSha: string;
    content: string;
}
interface PutFileRequest {
    path: string;
    branch: string;
    content: string;
    message: string;
    /** The blob this write replaces; null when the file must not exist yet. */
    expectedBlobSha: string | null;
}
/** The title and body a squash merge records, in place of GitHub's default. */
interface MergeMessage {
    subject: string;
    body: string;
}
/** What `formatSquashMessage` reads from a PR: its text and its commits, oldest first. */
interface SquashSource {
    title: string;
    body: string;
    commits: {
        subject: string;
        body: string;
    }[];
}
interface CheckRun {
    id: number;
    name: string;
    status: string;
    conclusion: string | null;
    startedAt: string | null;
    /** The commit the run checked; a run at any other sha says nothing about this head. */
    headSha: string;
    /** The GitHub App that posted the run; a required context counts only from an allowed app. */
    appId: number | null;
    /** The Actions run that owns this job, for `rerunFailed`; null for non-Actions checks. */
    workflowRunId: number | null;
    /** The pull requests GitHub ties the run to, so a run can be bound to one PR and base branch; empty for a fork's PR. */
    pullRequests: CheckRunPr[];
    url: string;
}
interface CheckRunPr {
    number: number;
    baseRef: string;
}

/** `owner/name`. */
type RepoSlug = string;
type MergeMethod = "merge" | "squash" | "rebase";
interface PullRequest {
    number: number;
    state: "open" | "closed";
    merged: boolean;
    /** Meaningful once `merged`; GitHub also fills it with a test merge while the PR is open. */
    mergeSha: string | null;
    /** ISO timestamp GitHub recorded when the PR merged; null while it has not. */
    mergedAt: string | null;
    headRef: string;
    headSha: string;
    /** `owner/name` of the repo the head lives in; null when that fork was deleted. */
    headRepo: RepoSlug | null;
    baseRef: string;
    draft: boolean;
    /** GitHub computes this lazily, so `unknown` is common and never means clean. */
    mergeableState: string;
    /** The head lacks commits the base has. */
    behind: boolean;
    /** How many base commits the head lacks; `getPr` reports it for an open PR, list rows never do. */
    behindBy?: number;
    /** Auto-merge is armed on the PR, read from the REST `auto_merge` field. */
    autoMerge: boolean;
    /** Absent where the wire does not read them; GitHub's REST answer carries both, an empty body as null. */
    title?: string;
    body?: string;
}
interface RequiredChecks {
    contexts: string[];
    /** The ruleset requires the branch to be up to date before merging. */
    strict: boolean;
    /** Apps a context is pinned to; a context absent here accepts a check from any app. */
    pins?: Record<string, number[]>;
}
/** A PR's head as GitHub reports it, so a delete can tell a same-named branch in a fork from its own. */
interface HeadRef {
    branch: string;
    repo: RepoSlug | null;
}
/** One changed file of a PR; a rename carries the path it came from. */
interface PrFile {
    path: string;
    previousPath?: string;
    status: string;
    /** Lines added; absent when the wire does not report it. */
    additions?: number;
    /** Lines deleted; absent when the wire does not report it. */
    deletions?: number;
}
interface CompareResult {
    mergeBaseSha: string;
    /** Paths changed between the merge base and `head`. */
    files: string[];
    /** GitHub caps compare at 300 files and 250 commits without saying so; when true, `files` may be missing paths. */
    truncated: boolean;
}
/** GitHub's limits for the compare API. */
declare const COMPARE_FILE_CAP = 300;
declare const COMPARE_COMMIT_CAP = 250;
/** GitHub's limit for `pulls/{n}/files`. */
declare const PR_FILES_CAP = 3000;
/** GitHub's limit for `pulls/{n}/commits`. */
declare const PR_COMMITS_CAP = 250;
interface IssueComment {
    id: number;
    body: string;
    /** Login of the commenter. */
    author: string;
}
/**
 * One GitHub call per method, unconditional, as GitHub itself behaves. `gh-cli.ts` and the test
 * fake implement it; `githubPort` puts the check-then-act rules on top of either.
 */
interface GitHubWire {
    getRef(repo: RepoSlug, branch: string): Promise<string | null>;
    createRef(repo: RepoSlug, branch: string, sha: string): Promise<void>;
    createCommit(repo: RepoSlug, request: {
        message: string;
        tree: string;
        parents: string[];
    }): Promise<{
        sha: string;
    }>;
    /** Moves `branch` to `sha`; GitHub refuses a move that is not a fast-forward. */
    updateRef(repo: RepoSlug, branch: string, sha: string): Promise<void>;
    deleteRef(repo: RepoSlug, branch: string): Promise<void>;
    getDefaultBranch(repo: RepoSlug): Promise<string>;
    getContent(repo: RepoSlug, path: string, ref: string): Promise<RepoFile | null>;
    putContent(repo: RepoSlug, request: PutFileRequest): Promise<{
        blobSha: string;
    }>;
    listPrs(repo: RepoSlug, headBranch: string): Promise<PullRequest[]>;
    listOpenPrs(repo: RepoSlug): Promise<PullRequest[]>;
    /** Sent with `If-None-Match: etag` when `etag` is set; GitHub charges a 304 no rate-limit point. */
    revalidateOpenPrs(repo: RepoSlug, etag: string | null): Promise<OpenPrList>;
    createPr(repo: RepoSlug, request: OpenPrRequest): Promise<PullRequest>;
    getPr(repo: RepoSlug, number: number): Promise<PullRequest>;
    getBranchRules(repo: RepoSlug, branch: string): Promise<RequiredChecks>;
    /** Classic branch protection's required status checks; a branch with none (HTTP 404) reads as an empty list. */
    getClassicRequiredChecks(repo: RepoSlug, branch: string): Promise<RequiredChecks>;
    reviewRulesBypassable(repo: RepoSlug, branch: string): Promise<boolean>;
    /** The branch endpoint's own `protected` flag; a missing or non-boolean answer throws, so it is never inferred. */
    getBranchProtected(repo: RepoSlug, branch: string): Promise<boolean>;
    listCheckRuns(repo: RepoSlug, sha: string): Promise<CheckRun[]>;
    /** Posts a completed check run as the GitHub App the wire was given a token for; the wire refuses when it has none. */
    createCheckRun(repo: RepoSlug, request: CreateCheckRunRequest): Promise<{
        id: number;
    }>;
    getCommit(repo: RepoSlug, sha: string): Promise<Commit>;
    /** Null when GitHub has no such commit (HTTP 422 or 404). */
    resolveCommit(repo: RepoSlug, sha: string): Promise<string | null>;
    listCommitStatuses(repo: RepoSlug, sha: string): Promise<CommitStatus[]>;
    getWorkflowRunStatus(repo: RepoSlug, runId: number): Promise<string>;
    getJobLog(repo: RepoSlug, jobId: number): Promise<string>;
    updateBranch(repo: RepoSlug, number: number, expectedHeadSha: string): Promise<void>;
    /** Retargets the PR onto `base`; the request carries no field but `base`. */
    setPrBase(repo: RepoSlug, number: number, base: string): Promise<void>;
    /** `message` becomes the squash commit's `commit_title` and `commit_message`; absent, GitHub writes its default. */
    merge(repo: RepoSlug, number: number, sha: string, method: MergeMethod, message?: MergeMessage): Promise<{
        sha: string;
    }>;
    getSquashSource(repo: RepoSlug, number: number): Promise<SquashSource>;
    rerunFailedJobs(repo: RepoSlug, runId: number): Promise<void>;
    /** `changedFiles` is the PR's own count, so the port can tell a capped list from a complete one. */
    listPrFiles(repo: RepoSlug, number: number): Promise<{
        files: PrFile[];
        changedFiles: number;
    }>;
    /** The PR's commit shas, oldest first; GitHub returns at most the first 250. */
    listPrCommits(repo: RepoSlug, number: number): Promise<string[]>;
    /** Commits on the default branch committed at or after `since`, newest first, every page. */
    listCommits(repo: RepoSlug, since: string): Promise<LoggedCommit[]>;
    compareFiles(repo: RepoSlug, base: string, head: string): Promise<CompareResult>;
    getAuthenticatedLogin(): Promise<string>;
    listIssueComments(repo: RepoSlug, number: number): Promise<IssueComment[]>;
    createComment(repo: RepoSlug, number: number, body: string): Promise<{
        id: number;
    }>;
    listReviewComments(repo: RepoSlug, number: number): Promise<ReviewComment[]>;
    /** The PR's first `FORCE_PUSHES_CAP` head force-pushes, oldest first, and whether more exist. */
    listForcePushes(repo: RepoSlug, number: number): Promise<ForcePushPage>;
}
type SkipReason = "exists" | "unchanged" | "merged" | "closed" | "head-moved" | "base-changed" | "up-to-date" | "in-progress" | "absent" | "default-branch" | "fork-head";
/** A write either happened now or was skipped because its effect is already in place (or can no longer apply). */
type WriteResult<T = object> = T & ({
    done: true;
} | {
    done: false;
    skipped: SkipReason;
});
/** Every write reads first, so repeating one after a crash is a no-op. */
interface GitHubPort {
    getHeadSha(repo: RepoSlug, branch: string): Promise<string | null>;
    ensureBranch(repo: RepoSlug, branch: string, baseSha: string): Promise<WriteResult<{
        sha: string;
    }>>;
    /** Refuses (skips) the default branch and a head that lives in another repo. */
    deleteRef(repo: RepoSlug, head: HeadRef): Promise<WriteResult>;
    getFile(repo: RepoSlug, path: string, ref: string): Promise<RepoFile | null>;
    putFile(repo: RepoSlug, request: PutFileRequest): Promise<WriteResult<{
        blobSha: string;
    }>>;
    findPr(repo: RepoSlug, headBranch: string): Promise<PullRequest | null>;
    /** List rows carry no `behind` or `mergeableState`; read one with `getPr` for those. */
    listOpenPrs(repo: RepoSlug, headPrefix?: string): Promise<PullRequest[]>;
    /** A conditional `listOpenPrs`: pass the `etag` of the last read, null for none. A poller that answers 304 costs no rate-limit point. */
    revalidateOpenPrs(repo: RepoSlug, etag: string | null): Promise<OpenPrList>;
    openPr(repo: RepoSlug, request: OpenPrRequest): Promise<WriteResult<{
        pr: PullRequest;
    }>>;
    getPr(repo: RepoSlug, number: number): Promise<PullRequest>;
    /** The repo's default branch as GitHub reports it now; a failed read throws. */
    defaultBranch(repo: RepoSlug): Promise<string>;
    /** Read from the branch's active rulesets, never hardcoded. */
    requiredChecks(repo: RepoSlug, branch: string): Promise<RequiredChecks>;
    /** The classic-protection counterpart of `requiredChecks`, for a branch whose rulesets require nothing. */
    classicRequiredChecks(repo: RepoSlug, branch: string): Promise<RequiredChecks>;
    /** True when the caller can bypass every pull_request rule on the branch that requires review, or none does; a read that fails throws. A rule that requires no review cannot be the block, so it is skipped. */
    reviewRulesBypassable(repo: RepoSlug, branch: string): Promise<boolean>;
    /** The branch's `protected` flag as GitHub reports it; a failed read throws. */
    branchProtected(repo: RepoSlug, branch: string): Promise<boolean>;
    /** Every run on `sha` from every app, superseded ones included; `mergeReadiness` needs this list. */
    checkRuns(repo: RepoSlug, sha: string): Promise<CheckRun[]>;
    /** The latest run for each check name on `sha`. */
    latestCheckRuns(repo: RepoSlug, sha: string): Promise<CheckRun[]>;
    /** Posts a completed check run under the App identity the wire was configured with; `conclusion` outside success, failure and action_required throws `GitHubInputError` before any call. */
    createCheckRun(repo: RepoSlug, request: CreateCheckRunRequest): Promise<{
        id: number;
    }>;
    getCommit(repo: RepoSlug, sha: string): Promise<Commit>;
    /** Expands an abbreviated sha to the full one GitHub has; null when GitHub has no such commit, so a caller never polls a sha that cannot report. */
    resolveCommit(repo: RepoSlug, sha: string): Promise<string | null>;
    commitStatuses(repo: RepoSlug, sha: string): Promise<CommitStatus[]>;
    /** The last `lines` lines of an Actions job's log. */
    jobLogTail(repo: RepoSlug, jobId: number, lines: number): Promise<string>;
    updateBranch(repo: RepoSlug, number: number, expectedHeadSha: string): Promise<WriteResult>;
    /** Retargets an open PR onto `base`, so a stacked child can follow its landed parent; a PR already on `base` skips as `unchanged`. */
    setPrBase(repo: RepoSlug, number: number, base: string): Promise<WriteResult>;
    /** Pushes a commit with the head's own tree onto `branch`, so CI runs again; skips as `head-moved` when the branch is not at `expectedHeadSha`. */
    pushEmptyCommit(repo: RepoSlug, branch: string, expectedHeadSha: string, message: string): Promise<WriteResult<{
        sha: string;
    }>>;
    /**
     * `message` is sent as the squash commit's title and body in place of GitHub's concatenation of the PR's commits.
     * With `expectedBase`, a PR whose base is another branch skips as `base-changed`, read before the write and before each retry.
     */
    merge(repo: RepoSlug, number: number, sha: string, method: MergeMethod, message?: MergeMessage, expectedBase?: string): Promise<WriteResult<{
        mergeSha: string;
    }>>;
    getSquashSource(repo: RepoSlug, number: number): Promise<SquashSource>;
    rerunFailed(repo: RepoSlug, runId: number): Promise<WriteResult>;
    /** Every changed file of the PR, all pages; `previousPath` is set on a rename. Throws `FileListTruncatedError` rather than return a short list. */
    listPrFiles(repo: RepoSlug, number: number): Promise<PrFile[]>;
    /** The PR's commit shas, oldest first. GitHub stops at the first 250, so a list whose last sha is not the head is short. */
    listPrCommits(repo: RepoSlug, number: number): Promise<string[]>;
    /** Commits on the default branch committed at or after `since`, newest first; one paged read covers every PR merged since. */
    listDefaultBranchCommits(repo: RepoSlug, since: string): Promise<LoggedCommit[]>;
    /** The merge base of `base` and `head`, and the paths changed since it; check `truncated` before trusting the list. */
    compareFiles(repo: RepoSlug, base: string, head: string): Promise<CompareResult>;
    /**
     * Lists the PR's comments first; a comment by the authenticated user with `marker` on a line of its own skips as
     * `exists`. The body should carry the marker. Two concurrent callers can both post; there is no lock.
     */
    upsertComment(repo: RepoSlug, number: number, marker: string, body: string): Promise<WriteResult<{
        id: number;
    }>>;
    /** Every inline review comment on the PR, resolved ones included; filter on `resolved`. */
    listReviewComments(repo: RepoSlug, number: number): Promise<ReviewComment[]>;
    /** The PR's head force-pushes, oldest first, each with the head it replaced and the new one. Throws `ForcePushesTruncated` rather than return a short list. */
    listForcePushes(repo: RepoSlug, number: number): Promise<ForcePush[]>;
}
/** A write whose precondition no longer holds, such as a blob that changed under an edit. */
declare class GitHubConflictError extends Error {
    constructor(message: string);
}
interface GitHubPortOptions {
    /**
     * The login `upsertComment` owns comments as, for example `my-app[bot]`. Set it under a GitHub App installation
     * token: `GET /user` answers 403 there, and `GET /app` needs an App JWT the installation token is not.
     */
    login?: string;
    /** Waits between retries of a comment post, a merge or a rerun; tests inject one that does not wait. */
    sleep?: (ms: number) => Promise<void>;
}
/** Every argument is validated before any wire call, because each one becomes part of a `gh api` path. */
declare function githubPort(wire: GitHubWire, options?: GitHubPortOptions): GitHubPort;
/** The list came back shorter than the PR's own count, so a path may be missing. */
declare class FileListTruncatedError extends Error {
    readonly expected: number;
    readonly received: number;
    constructor(expected: number, received: number);
}

/** A write that kept answering a 5xx or an unreadable answer; `status` is the last answer's, so callers still classify it. */
declare class WriteRetriesExhaustedError extends Error {
    readonly step: string;
    readonly last: unknown;
    readonly status: number | undefined;
    constructor(step: string, attempts: number, last: unknown);
}

declare function isPassing(run: CheckRun): boolean;
/** One head can carry several runs per name (a superseded run is `cancelled`); only the newest counts. */
declare function latestPerName(runs: readonly CheckRun[]): CheckRun[];

interface CiVerdictInput {
    /** The base branch's required contexts; an empty list judges every run and status instead. */
    rules: RequiredChecks;
    runs: readonly CheckRun[];
    statuses: readonly CommitStatus[];
}
/** `reasons` names the pending contexts, or each red one as `name=conclusion`; empty when green. */
interface CiVerdict {
    verdict: "green" | "red" | "pending";
    reasons: string[];
}
/**
 * Pure. With required contexts, each must be green the way a merge gate judges it and other runs are ignored;
 * without any, every run and status must pass and at least one check-run must exist. Pending outranks red, so a
 * red verdict names every failure, not just the first to finish.
 */
declare function ciVerdict(input: CiVerdictInput): CiVerdict;
/** Rulesets first, then classic protection; both read a free-plan 403 as none, so an empty list means the all-runs rule applies. */
declare function loadRequiredContexts(port: GitHubPort, repo: RepoSlug, branch: string): Promise<RequiredChecks>;

interface CiWaitOptions {
    repo: RepoSlug;
    /** Seven to 40 lower-case hex characters; an abbreviation is expanded before the first poll. */
    sha: string;
    /** The branch whose required contexts apply; the repo's default branch when absent. */
    base?: string;
    timeoutSeconds: number;
    intervalSeconds: number;
    now: () => number;
    sleep: (ms: number) => Promise<void>;
    /** Told of each failed read, which is retried on the next poll and never decides the outcome. */
    onReadError?: (error: unknown) => void;
}
type CiWaitOutcome = "green" | "red" | "timeout" | "unknown-sha";
/** `line` is what `ci-wait` prints: on stdout for green, red and timeout, on stderr for an unknown sha. */
interface CiWaitResult {
    outcome: CiWaitOutcome;
    line: string;
}
/**
 * Polls until the sha's CI is green or red, or the next poll would pass the deadline. The required contexts
 * are read once. A sha GitHub does not have ends at once, because its status would read pending forever.
 */
declare function ciWait(port: GitHubPort, options: CiWaitOptions): Promise<CiWaitResult>;

/** How many base merges may sit between the approved head and the PR head, as in agent-chat's `scripts/seat/premerge`. */
declare const MAX_BASE_MERGES = 5;
/**
 * The tree of a clean merge of `baseParent` and `reviewed` (`git merge-tree --write-tree`), or null
 * when they conflict. The package does no git, so the caller supplies it.
 */
type CleanMergeTree = (baseParent: string, reviewed: string) => Promise<string | null>;
interface ApprovedHeadWalkInput {
    headSha: string;
    approvedHead: string;
    baseRef: string;
    maxBaseMerges?: number;
    /** Absent, or failing, any head other than the approved one is refused: shape alone cannot rule out an evil merge. */
    cleanMergeTree?: CleanMergeTree;
}
/**
 * Whether `headSha` is `approvedHead` plus only merges of the base branch. On success `baseParents`
 * holds each merge's base-side parent, newest first; on failure `reasons` say why in premerge's words.
 */
type ApprovedHeadWalk = {
    headSha: string;
    approvedHead: string;
} & ({
    ok: true;
    baseParents: string[];
} | {
    ok: false;
    reasons: string[];
});
/**
 * Follows first parents from the head through two-parent merges until one has the approved head
 * as a parent. Each merge's other parent must be on the base branch and inside the newest one, or
 * the newest merge could have dropped base commits an earlier one brought in. Last, the head's tree
 * must equal a clean merge of the newest base parent into the approved head, which proves no merge
 * changed PR content, conflict resolutions included.
 */
declare function approvedHeadWalk(port: GitHubPort, repo: RepoSlug, input: ApprovedHeadWalkInput): Promise<ApprovedHeadWalk>;

/** The GitHub Actions app; on this owner's repos every required check comes from it. */
declare const GITHUB_ACTIONS_APP_ID = 15368;
type MergeBlockReason = "merged" | "closed" | "draft" | "no-required-checks" | "unapproved" | "head-moved" | "behind" | "conflict" | "mergeability-unknown" | "check-pending" | "check-failed";
interface MergeBlocker {
    reason: MergeBlockReason;
    detail: string;
}
interface MergeReadinessInput {
    pr: PullRequest;
    rules: RequiredChecks;
    /** Check runs from any app at any sha; only runs from `requiredApps` at `pr.headSha` count. */
    runs: readonly CheckRun[];
    requiredApps: readonly number[];
    /** The head the approval named; null when nothing is approved. */
    approvedHead: string | null;
    /** `approvedHeadWalk` from the PR head to `approvedHead`; an ok walk lets an approval of an earlier head stand. */
    approvalWalk?: ApprovedHeadWalk;
}
/** `ready` is true exactly when `blockers` is empty; every blocker says why. */
interface MergeReadiness {
    ready: boolean;
    blockers: MergeBlocker[];
}
/** Pure: decides from the snapshot it is given, so the caller controls when GitHub is read. */
declare function mergeReadiness(input: MergeReadinessInput): MergeReadiness;
interface HeadChecksInput {
    headSha: string;
    /** Required check contexts; each needs a completed run concluding success. */
    contexts: readonly string[];
    /** Check runs from any app at any sha; only runs from `requiredApps` at `headSha` count. */
    runs: readonly CheckRun[];
    requiredApps: readonly number[];
}
/** Why the head is not green yet: a required context with no counted run, a run still going, or a run that did not pass. */
type CheckFinding = {
    kind: "missing";
    name: string;
} | {
    kind: "pending" | "failed";
    run: CheckRun;
};
/**
 * Only runs from an allowed app at the head count, as in authority's MRG-AU-RV. Every counted run
 * must be green, superseded or not, and each required context needs a completed run concluding success.
 * An empty result means the head is green.
 */
declare function headCheckFindings({ headSha, contexts, runs, requiredApps }: HeadChecksInput): CheckFinding[];

type RateLane = "rest" | "graphql";
/** GitHub's own count for one lane, as its last answer's `x-ratelimit-*` headers put it. */
interface RateWindow {
    limit: number;
    remaining: number;
    used: number;
    /** Epoch milliseconds. */
    resetAt: number;
}
/** A lane the throttle saw limited, and until when; a primary limit lasts to the window's reset, a secondary one to its retry-after. */
interface Cooldown {
    lane: RateLane;
    class: "primary" | "secondary";
    /** Epoch milliseconds. */
    until: number;
}
interface GatewayBudget {
    lanes: Partial<Record<RateLane, RateWindow>>;
    /** Only the cooldowns still running. */
    cooldowns: Cooldown[];
}
interface OctokitClientOptions {
    /** Defaults to `gh auth token`, so the client speaks as the same login `gh` does. */
    token?: () => Promise<string>;
    /** Re-read the token once on a 401; off for a token that cannot change, such as an App JWT. Defaults to on. */
    reauthOn401?: boolean;
    fetch?: typeof globalThis.fetch;
    now?: () => number;
    /** Keys the throttle's limiters, so a second identity (an App installation) never waits behind the user's writes. */
    throttleId?: string;
    /**
     * The proactive floor every call acquires before it goes out, as `restCaller` does: below `RATE_FLOOR` remaining, calls
     * spread over the time left. Defaults to `sharedRateBudget`, the user login's; another identity passes its own.
     */
    budget?: RateBudget;
}
interface GitHubClient {
    request: Octokit["request"];
    budget(): GatewayBudget;
}
/** A failed call, rebuilt with only its status, headers and a redacted message, so no token or body travels with it. */
declare class GitHubRequestError extends Error {
    readonly status: number;
    readonly headers: Readonly<Record<string, string>>;
    constructor(message: string, status: number, headers: Readonly<Record<string, string>>);
}
declare function octokitClient(options?: OctokitClientOptions): GitHubClient;
/** One client per process, so every service call in it shares one throttle; the token is read on the first request. */
declare function sharedOctokit(): GitHubClient;

interface AppCredentials {
    appId: number;
    installationId: number;
    privateKeyPem: string;
    /** Epoch milliseconds; injected so a test controls expiry. */
    now: () => number;
}
interface InstallationToken {
    token: string;
    /** Epoch milliseconds. */
    expiresAtMs: number;
}
/** An RS256 JWT for `iss = appId`: issued 60 s in the past for clock skew, valid under GitHub's 10 minute ceiling. */
declare function signAppJwt(appId: number, privateKeyPem: string, nowMs: number): string;
/** Exchanges a freshly signed App JWT for an installation token; the JWT reaches `gh` as `GH_TOKEN` for this call only. */
declare function appInstallationToken(credentials: AppCredentials, exec?: GhExec): Promise<InstallationToken>;
/** The same exchange over Octokit, with the JWT as this one client's bearer token; no `gh` process and no child env. */
declare function appInstallationTokenOverHttp(credentials: AppCredentials, clientOptions?: Omit<OctokitClientOptions, "token" | "reauthOn401">): Promise<InstallationToken>;

interface GhCliOptions {
    /** Defaults to one budget per process, because GitHub counts calls per login. */
    budget?: RateBudget;
    /** Most recent conditional GETs whose ETag and body are kept. */
    etagCacheSize?: number;
    /**
     * Mints the GitHub App installation token that `createCheckRun` posts under. It is called per
     * check run, so a cached provider should refresh itself; without it `createCheckRun` refuses.
     */
    appToken?: () => Promise<string>;
    /** Waits between attempts of a failed read; tests inject one so they do not sleep. */
    sleep?: (ms: number) => Promise<void>;
}
/** The `gh` CLI wire, for CLI processes; a long-running service uses `octokitWire` instead. */
declare function ghCliWire(exec?: GhExec, options?: GhCliOptions): GitHubWire;

interface OctokitWireOptions {
    /** Defaults to the process's shared client, so every wire in a service spends one throttled budget. */
    client?: GitHubClient;
    /** Most recent conditional GETs whose ETag and body are kept. */
    etagCacheSize?: number;
    /** Mints the GitHub App installation token `createCheckRun` posts under, per check run; without it `createCheckRun` refuses. */
    appToken?: () => Promise<string>;
    /** Options for the App identity's own client; its token is always the one `appToken` minted. */
    appClientOptions?: Omit<OctokitClientOptions, "token" | "reauthOn401">;
}
/** The wire a long-running service uses: Octokit with throttling, GET-only retry and ETag reads, behind the same port as `ghCliWire`. */
declare function octokitWire(options?: OctokitWireOptions): GitHubWire;

/**
 * The `Rest` port over one Octokit client, with `restCaller`'s semantics: GETs conditional on a bounded ETag cache, an
 * unconditional 304 refused, next pages followed only on the API origin. Retries and rate-limit waits are the client's.
 */
declare function octokitRest(client: GitHubClient, cacheSize?: number): Rest;

/** A value that would change which GitHub resource a `gh api` path names; thrown before any call. */
declare class GitHubInputError extends Error {
    readonly field: string;
    readonly value: unknown;
    constructor(field: string, value: unknown, reason: string);
}
/**
 * True for a bare `owner/name`. A `.git` suffix is refused: it names the same repo as the bare form
 * but compares unequal, so it would slip past a deny list. Never throws.
 */
declare function isRepo(value: string): boolean;

/** Counts of calls that change GitHub; a crash test asserts each is at most one. */
interface FakeEffects {
    createRef: number;
    deleteRef: number;
    putContent: number;
    createPr: number;
    updateBranch: number;
    updateRef: number;
    merge: number;
    rerunFailedJobs: number;
}
/** Reads a test can make fail, for a caller that must treat a failed read as transient. */
type FakeFaultyRead = "getDefaultBranch" | "getBranchRules" | "getClassicRequiredChecks" | "listCheckRuns" | "listCommitStatuses" | "resolveCommit";
interface FakeGitHub {
    wire: GitHubWire;
    effects: FakeEffects;
    /** Every wire call in order, as `method` names; lets a test prove what was never called. */
    calls: string[];
    /** Calls in `calls` that answered 304: each is still a request, but GitHub charges it no rate-limit point. */
    notModified: number;
    rules: RequiredChecks;
    /** What classic branch protection requires; empty reads as a branch with none. */
    classicRules: RequiredChecks;
    /** What `reviewRulesBypassable` answers; false like a repo whose approval rule the caller cannot bypass. */
    reviewBypass: boolean;
    /** What the branch endpoint's `protected` flag answers. */
    branchProtected: boolean;
    addPr(fields: Partial<PullRequest> & {
        headSha: string;
    }): PullRequest;
    /** The live record, so a test can move the world (behind, mergeable_state) between steps. */
    pr(number: number): PullRequest;
    /** Stored as given, except a run with no `headSha` is stamped with `sha`; picking the latest run per name is the port's job. */
    setRuns(sha: string, runs: CheckRun[]): void;
    /** A foreign push: moves the PR head without this run doing it. */
    pushHead(number: number, sha: string): void;
    /** When set, update-branch answers HTTP 422 "merge conflict between base and head", as GitHub does when the base cannot merge in. */
    updateBranchConflict?: boolean;
    /** Faults the next update-branch calls throw, one per call; `lands` means the update happened before the answer was lost. */
    updateBranchFaults?: {
        error: Error;
        lands?: boolean;
    }[];
    /** Faults the next comment posts throw, one per call; `lands` means the comment was posted before the answer was lost. */
    createCommentFaults?: {
        error: Error;
        lands?: boolean;
    }[];
    /** Faults the next merge PUTs throw, one per call; `lands` means the merge happened before the answer was lost. */
    mergeFaults?: {
        error: Error;
        lands?: boolean;
    }[];
    /** Faults the next rerun-failed-jobs posts throw, one per call; `lands` means the rerun was queued before the answer was lost. */
    rerunFaults?: {
        error: Error;
        lands?: boolean;
    }[];
    /** Called at the start of every `getPr`, so a test can move the world between polls. */
    onGetPr?: (pr: PullRequest, reads: number) => void;
    /** Every check run created, with the title, summary and external id that `CheckRun` does not carry. */
    createdCheckRuns: {
        id: number;
        repo: string;
        request: CreateCheckRunRequest;
    }[];
    commits: Map<string, Commit>;
    /** Sha to its combined status, newest per context. */
    statuses: Map<string, CommitStatus[]>;
    /** Errors the next calls of a read throw, one per call, before it answers. */
    readFaults: Partial<Record<FakeFaultyRead, Error[]>>;
    refs: Map<string, string>;
    /** Job id to full log text, for `getJobLog`. */
    jobLogs: Map<number, string>;
    files: Map<string, {
        content: string;
        blobSha: string;
    }>;
    /** The login `createComment` posts as and `getAuthenticatedLogin` answers with. */
    actor: string;
    /** PR number to its changed files. `listPrFiles` returns at most 3,000 of them, like GitHub. */
    prFiles: Map<number, PrFile[]>;
    /** PR number to the PR's own `changed_files` count; unset means the length of `prFiles`. */
    prChangedFiles: Map<number, number>;
    /** PR number to its commit shas, oldest first; unset means the PR's head alone. `listPrCommits` returns at most 250, like GitHub. */
    prCommits: Map<number, string[]>;
    /** PR number to what `getSquashSource` reads; unset reads as an empty title, body and commit list. */
    squashSources: Map<number, SquashSource>;
    /** Every `merge` PUT's pull number and message, in order; `message` is undefined when none was sent. */
    merges: {
        number: number;
        message: MergeMessage | undefined;
    }[];
    /** Every PR base change that landed, in order; its length counts the retargets, so `FakeEffects` stays as it was. */
    baseChanges: {
        number: number;
        base: string;
    }[];
    /** The default branch's history for `listCommits`, in any order; it answers those at or after `since`, newest first. */
    history: (LoggedCommit & {
        committedAt: string;
    })[];
    /** `base...head` to the compare inputs; an unset pair compares as no change. Caps of 300 files and 250 commits apply. */
    compares: Map<string, {
        mergeBaseSha: string;
        files: string[];
        totalCommits?: number;
    }>;
    /** PR number to its issue comments, in posting order. */
    comments: Map<number, IssueComment[]>;
    /** PR number to its inline review comments, resolved or not. */
    reviewComments: Map<number, ReviewComment[]>;
    /** PR number to its head force-pushes, oldest first; unset means none. `listForcePushes` reads at most 100, like the GraphQL page. */
    forcePushes: Map<number, ForcePush[]>;
}

declare class FakeHttpError extends Error {
    readonly status: number;
    constructor(status: number, message: string);
}
/** A real-shaped commit sha, stable per tag, so tests can name heads. */
declare function fakeSha(tag: string): string;
declare function successRun(name: string, id: number, startedAt?: string, conclusion?: string, appId?: number, headSha?: string): CheckRun;
/** The App id the fake posts check runs as unless `fakeGitHub({ appId })` says otherwise. */
declare const FAKE_APP_ID = 424242;
/** An in-memory GitHub: one repo slug per key, strict rules, and unconditional writes like the real API. */
declare function fakeGitHub(options?: {
    base?: string;
    baseSha?: string;
    repo?: string;
    appId?: number;
}): FakeGitHub;

interface SquashCommit {
    readonly subject: string;
    readonly body: string;
}
interface SquashInput {
    readonly title: string;
    readonly body: string;
    readonly prNumber: number;
    readonly taskIds: readonly string[];
    readonly commits: readonly SquashCommit[];
}
interface SquashMessage {
    readonly subject: string;
    readonly body: string;
}
/** Pure: the same input always yields byte-identical output, and re-formatting its own output changes nothing. */
declare function formatSquashMessage(input: SquashInput): SquashMessage;

export { type AppCredentials, type ApprovedHeadWalk, type ApprovedHeadWalkInput, CHECK_CONCLUSIONS, COMPARE_COMMIT_CAP, COMPARE_FILE_CAP, type CheckConclusion, type CheckFinding, type CheckRun, type CheckRunPr, type CiVerdict, type CiVerdictInput, type CiWaitOptions, type CiWaitOutcome, type CiWaitResult, type CleanMergeTree, type Commit, type CommitStatus, type CompareResult, type Cooldown, type CreateCheckRunRequest, FAKE_APP_ID, FORCE_PUSHES_CAP, type FakeEffects, type FakeFaultyRead, type FakeGitHub, FakeHttpError, type Fields, FileListTruncatedError, type ForcePush, type ForcePushPage, ForcePushesTruncated, GITHUB_ACTIONS_APP_ID, type GatewayBudget, type GhCliOptions, GhError, type GhExec, type GhExecOptions, type GhResult, type GitHubClient, GitHubConflictError, GitHubInputError, type GitHubPort, type GitHubPortOptions, GitHubRequestError, type GitHubWire, type HeadChecksInput, type HeadRef, type InstallationToken, type IssueComment, type LoggedCommit, MAX_BASE_MERGES, type MergeBlockReason, type MergeBlocker, type MergeMessage, type MergeMethod, type MergeReadiness, type MergeReadinessInput, type OctokitClientOptions, type OctokitWireOptions, type OpenPrList, type OpenPrRequest, PR_COMMITS_CAP, PR_FILES_CAP, type PrFile, type PullRequest, type PutFileRequest, RATE_FLOOR, type RateBudget, type RateBudgetOptions, type RateLane, type RateWindow, type RepoFile, type RepoSlug, type RequiredChecks, type Rest, type ReviewComment, type SkipReason, type SquashCommit, type SquashInput, type SquashMessage, type SquashSource, type WriteResult, WriteRetriesExhaustedError, appInstallationToken, appInstallationTokenOverHttp, approvedHeadWalk, backoffMs, ciVerdict, ciWait, execGh, fakeGitHub, fakeSha, formatSquashMessage, ghCliWire, githubPort, headCheckFindings, isPassing, isRepo, latestPerName, loadRequiredContexts, mergeReadiness, octokitClient, octokitRest, octokitWire, rateBudget, sharedOctokit, sharedRateBudget, signAppJwt, successRun };
