/** One inline review comment; a comment is resolved when its review thread is. */
export interface ReviewComment {
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
