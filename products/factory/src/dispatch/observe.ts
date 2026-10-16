import { GIT_BIN } from "./review-diff.js";
import type { Runner } from "./runner.js";

/** `origin/HEAD`'s branch, which the brief's first step merges from; `main` when the clone has none. */
export function defaultBranch(repo: string, exec: Runner): string {
  const result = exec(GIT_BIN, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], repo);
  const ref = result.status === 0 ? result.stdout.trim() : "";
  return ref.startsWith("origin/") ? ref.slice("origin/".length) : "main";
}
