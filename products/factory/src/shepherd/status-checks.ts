import { statusCheckRuns, type GitHubPort, type RepoSlug } from "@titan-design/github";

/** The commit-status contexts a repo's CI posts instead of Actions runs; empty for every repo that has none configured. */
type StatusContexts = (repo: RepoSlug) => readonly string[];

/** Reads `shepherd.repos.<repo>.statusContexts` afresh on each call; keys match in any case, and every matching key counts. */
export function configuredStatusContexts(read: () => Readonly<Record<string, { statusContexts?: readonly string[] }>> | undefined): StatusContexts {
  return (repo) => {
    const entries = Object.entries(read() ?? {}).filter(([key]) => key.toLowerCase() === repo.toLowerCase());
    return [...new Set(entries.flatMap(([, config]) => config.statusContexts ?? []))];
  };
}

/**
 * Every check-run read of a repo with status contexts also carries each context as a check run, so land's ci-wait, its
 * open-repo rule and main CI judge it with the same judges as Actions runs. A repo with none reads exactly as before. A
 * failed status read fails the check-run read, so a red status that could not be read never reads as green.
 */
export function withStatusChecks(port: GitHubPort, contextsFor: StatusContexts): GitHubPort {
  return {
    ...port,
    checkRuns: async (repo, sha) => {
      const contexts = contextsFor(repo);
      if (contexts.length === 0) return port.checkRuns(repo, sha);
      const [runs, statuses] = await Promise.all([port.checkRuns(repo, sha), port.commitStatuses(repo, sha)]);
      return [...runs, ...statusCheckRuns(statuses, sha, contexts)];
    },
  };
}
