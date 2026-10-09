import { formatSquashMessage, type GitHubPort, type MergeMessage, type RepoSlug } from "@titan-design/github";

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
  const [text, commits] = await Promise.all([port.getPrText(repo, pr), port.listPrCommitMessages(repo, pr)]);
  try {
    return formatSquashMessage({ title: text.title, body: text.body, prNumber: pr, taskIds, commits });
  } catch (error) {
    warn(`land: formatting the squash message of ${repo}#${pr} failed, merging with the plain title: ${error instanceof Error ? error.message : String(error)}`);
    return { subject: text.title, body: "" };
  }
}
