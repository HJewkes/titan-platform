interface Octokit {
  activity: { listRepoEvents: (args: { owner: string; repo: string }) => Promise<unknown> };
}
export const poll = (octokit: Octokit): Promise<unknown> => octokit.activity.listRepoEvents({ owner: "o", repo: "r" });
