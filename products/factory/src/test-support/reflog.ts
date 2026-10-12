import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { onTestFinished } from "vitest";

export const reflogLine = (from: string, to: string): string => `${from} ${to} Demo Agent <agent@example.test> 1760000000 +0000\tupdate by push\n`;

export const reflogPath = (clone: string, branch: string): string => join(clone, ".git", "logs", "refs", "remotes", "origin", ...branch.split("/"));

/** A clone whose `.git` holds only the remote-tracking reflogs, removed when the test ends; `push` appends what `git push` would. */
export function fixtureClone(): { clone: string; push: (branch: string, from: string, to: string) => void } {
  const clone = mkdtempSync(join(tmpdir(), "push-signal-"));
  onTestFinished(() => rmSync(clone, { recursive: true, force: true }));
  mkdirSync(join(clone, ".git"));
  const push = (branch: string, from: string, to: string): void => {
    const path = reflogPath(clone, branch);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, reflogLine(from, to));
  };
  return { clone, push };
}
