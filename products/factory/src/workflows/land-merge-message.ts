import { formatSquashMessage, type GitHubPort, type MergeMessage, type MergeMethod, type RepoSlug } from "@titan-design/github";

export interface MergeInput {
  repo: string;
  pr: number;
  sha: string;
  method: MergeMethod;
  /** Absent on a merge step recorded before the field existed. */
  taskIds?: string[];
}

/** Only a squash records a message of its own; a merge commit or a rebase keeps the PR's commits as they are. */
export async function mergeWithMessage(port: GitHubPort, input: MergeInput) {
  if (input.method !== "squash") return port.merge(input.repo, input.pr, input.sha, input.method);
  return port.merge(input.repo, input.pr, input.sha, input.method, await squashMessageFor(port, input.repo, input.pr, input.taskIds ?? []));
}

/** The id half of a registration's `<initiative>/<ID>` task, which is what a commit subject names. */
export function taskIdOf(task: string | undefined): string[] {
  const id = task?.split("/").at(-1)?.trim();
  return id ? [id] : [];
}

/**
 * The squash subject and body for a PR. Formatting that throws falls back to the plain title and an empty body, so
 * GitHub's default concatenation of the PR's commits, trailers and addresses included, is never what lands.
 */
export async function squashMessageFor(port: GitHubPort, repo: RepoSlug, pr: number, taskIds: readonly string[], warn: (line: string) => void = console.warn): Promise<MergeMessage> {
  const source = await port.getSquashSource(repo, pr);
  try {
    return formatSquashMessage({ ...source, prNumber: pr, taskIds });
  } catch (error) {
    warn(`land: formatting the squash message of ${repo}#${pr} failed, merging with the plain title: ${error instanceof Error ? error.message : String(error)}`);
    return { subject: source.title, body: "" };
  }
}
