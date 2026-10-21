export const poll = (owner: string, repo: string): string => `gh api repos/${owner}/${repo}/events`;
