export interface Commit {
  sha: string;
  parents: string[];
  /** The tree the commit records; absent when the wire does not report it. */
  tree?: string;
  /** The committer date; for a commit GitHub made on merge, when it landed. Absent when the wire does not report it. */
  committedAt?: string;
}

/** A commit on the default branch with its full message, subject line first. */
export interface LoggedCommit {
  sha: string;
  message: string;
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
