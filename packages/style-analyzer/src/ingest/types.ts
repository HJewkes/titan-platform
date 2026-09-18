export interface IngestConfig {
  repos: string[];
  since?: string;
  until?: string;
  languages: string[];
  githubToken: string;
  cacheDir?: string;
}

export interface CodeFile {
  path: string;
  content: string;
  language: string;
  repo: string;
  sha: string;
}

export interface ReviewComment {
  body: string;
  path: string;
  line: number | null;
  author: string;
  prNumber: number;
  repo: string;
  createdAt: string;
}

export interface PullRequest {
  number: number;
  title: string;
  repo: string;
  author: string;
  files: PullRequestFile[];
  comments: ReviewComment[];
}

export interface PullRequestFile {
  filename: string;
  status: "added" | "modified" | "removed" | "renamed";
  patch?: string;
  additions: number;
  deletions: number;
}

export interface CodeCorpus {
  files: CodeFile[];
  pullRequests: PullRequest[];
  reviewComments: ReviewComment[];
  metadata: IngestMetadata;
}

export interface IngestMetadata {
  repos: string[];
  author: string;
  since?: string;
  until?: string;
  fetchedAt: string;
  totalCommits: number;
  totalFiles: number;
  totalReviewComments: number;
}
