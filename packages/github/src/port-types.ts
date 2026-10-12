export interface Commit {
  sha: string;
  parents: string[];
  /** The tree the commit records; absent when the wire does not report it. */
  tree?: string;
  /** The committer date; for a commit GitHub made on merge, when it landed. Absent when the wire does not report it. */
  committedAt?: string;
}

/** The newest commit status per context on a sha, as the combined status endpoint reports it. */
export interface CommitStatus {
  context: string;
  /** `success`, `pending`, `failure` or `error`. */
  state: string;
}

/** A commit on the default branch with its full message, subject line first. */
export interface LoggedCommit {
  sha: string;
  message: string;
}

export interface RepoFile {
  path: string;
  blobSha: string;
  content: string;
}

export interface PutFileRequest {
  path: string;
  branch: string;
  content: string;
  message: string;
  /** The blob this write replaces; null when the file must not exist yet. */
  expectedBlobSha: string | null;
}

/** The title and body a squash merge records, in place of GitHub's default. */
export interface MergeMessage {
  subject: string;
  body: string;
}

/** What `formatSquashMessage` reads from a PR: its text and its commits, oldest first. */
export interface SquashSource {
  title: string;
  body: string;
  commits: { subject: string; body: string }[];
}

export interface CheckRun {
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

export interface CheckRunPr {
  number: number;
  baseRef: string;
}
