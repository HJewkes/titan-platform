import type { CreateCheckRunRequest } from "./check-run-create.js";
import type { ForcePush } from "./force-pushes.js";
import type { MergeIntoBranchResult } from "./merge-into-branch.js";
import type { ReviewComment } from "./review-comment.js";
import type { CheckRun, Commit, CommitStatus, GitHubWire, IssueComment, LoggedCommit, MergeMessage, PrFile, PullRequest, RequiredChecks, SquashSource } from "./port.js";

/** Counts of calls that change GitHub; a crash test asserts each is at most one. */
export interface FakeEffects {
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
export type FakeFaultyRead = "getDefaultBranch" | "getBranchRules" | "getClassicRequiredChecks" | "listCheckRuns" | "listCommitStatuses" | "resolveCommit";

export interface FakeGitHub {
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
  addPr(fields: Partial<PullRequest> & { headSha: string }): PullRequest;
  /** The live record, so a test can move the world (behind, mergeable_state) between steps. */
  pr(number: number): PullRequest;
  /** Stored as given, except a run with no `headSha` is stamped with `sha`; picking the latest run per name is the port's job. */
  setRuns(sha: string, runs: CheckRun[]): void;
  /** A foreign push: moves the PR head without this run doing it. */
  pushHead(number: number, sha: string): void;
  /** When set, update-branch answers HTTP 422 "merge conflict between base and head", as GitHub does when the base cannot merge in. */
  updateBranchConflict?: boolean;
  /** Faults the next update-branch calls throw, one per call; `lands` means the update happened before the answer was lost. */
  updateBranchFaults?: { error: Error; lands?: boolean }[];
  /** Faults the next comment posts throw, one per call; `lands` means the comment was posted before the answer was lost. */
  createCommentFaults?: { error: Error; lands?: boolean }[];
  /** Faults the next merge PUTs throw, one per call; `lands` means the merge happened before the answer was lost. */
  mergeFaults?: { error: Error; lands?: boolean }[];
  /** Faults the next rerun-failed-jobs posts throw, one per call; `lands` means the rerun was queued before the answer was lost. */
  rerunFaults?: { error: Error; lands?: boolean }[];
  /** Called at the start of every `getPr`, so a test can move the world between polls. */
  onGetPr?: (pr: PullRequest, reads: number) => void;
  /** Every check run created, with the title, summary and external id that `CheckRun` does not carry. */
  createdCheckRuns: { id: number; repo: string; request: CreateCheckRunRequest }[];
  commits: Map<string, Commit>;
  /** Sha to its combined status, newest per context. */
  statuses: Map<string, CommitStatus[]>;
  /** Errors the next calls of a read throw, one per call, before it answers. */
  readFaults: Partial<Record<FakeFaultyRead, Error[]>>;
  refs: Map<string, string>;
  /** Job id to full log text, for `getJobLog`. */
  jobLogs: Map<number, string>;
  files: Map<string, { content: string; blobSha: string }>;
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
  merges: { number: number; message: MergeMessage | undefined }[];
  /** Head shas whose merge into any branch answers a conflict, as GitHub's Merges API does with 409. */
  mergeConflicts: Set<string>;
  /** Every Merges API call that reached a branch, in order, with what it answered; `FakeEffects` stays as it was. */
  branchMerges: { branch: string; head: string; outcome: MergeIntoBranchResult["outcome"] }[];
  /** Every PR base change that landed, in order; its length counts the retargets, so `FakeEffects` stays as it was. */
  baseChanges: { number: number; base: string }[];
  /** The default branch's history for `listCommits`, in any order; it answers those at or after `since`, newest first. */
  history: (LoggedCommit & { committedAt: string })[];
  /** `base...head` to the compare inputs; an unset pair compares as no change. Caps of 300 files and 250 commits apply. */
  compares: Map<string, { mergeBaseSha: string; files: string[]; totalCommits?: number }>;
  /** PR number to its issue comments, in posting order. */
  comments: Map<number, IssueComment[]>;
  /** PR number to its inline review comments, resolved or not. */
  reviewComments: Map<number, ReviewComment[]>;
  /** PR number to its head force-pushes, oldest first; unset means none. `listForcePushes` reads at most 100, like the GraphQL page. */
  forcePushes: Map<number, ForcePush[]>;
}
