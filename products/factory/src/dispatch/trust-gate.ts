import { join } from "node:path";

/** Where a tick-spawned agent's worktree would be cut, which does not exist yet at plan time. */
export const worktreePathFor = (repo: string, agentName: string): string => join(repo, ".worktrees", agentName);
