import { detectGitToplevel, hasNoCommits, runGitLargeResult, valueOrNull, type GitLargeResult, type HistoryLoad } from "./git.js";
import { revArgs } from "./window.js";
import { canonicalize, COMMIT_HASH_RE, rebasePath, resolveRenamedPath } from "./log.js";

export interface FirstSeenOptions {
  /** Directory paths are made relative to; paths outside it are dropped. */
  repoRoot: string;
  knownPaths?: ReadonlySet<string>;
  /** Walk history from this rev instead of HEAD. */
  rev?: string;
}

/**
 * Earliest commit time (epoch seconds) per path, from one reverse-ordered pass
 * over full history up to `rev` (default HEAD): the first commit that touched a path approximates its birth.
 * Rebased onto `repoRoot` and filtered to `knownPaths` when given. Renames slightly
 * underestimate age (pre-rename history lives under the old path). Returns null
 * when `repoRoot` is not a git checkout or git is missing, so callers degrade to "no age discount".
 * Throws a `GitHistoryError` when the log overflowed or git failed; use {@link loadFirstSeenResult}
 * to branch on the outcome instead.
 */
export function loadFileFirstSeen(options: FirstSeenOptions): Map<string, number> | null {
  return valueOrNull(loadFirstSeenResult(options));
}

/** {@link loadFileFirstSeen} with the failure kind (`not-git`, `overflow`, `git-error`) kept apart. */
export function loadFirstSeenResult(options: FirstSeenOptions): HistoryLoad<Map<string, number>> {
  const gitRoot = detectGitToplevel(options.repoRoot);
  if (gitRoot === null) return { ok: false, reason: "not-git", detail: `${options.repoRoot} is not a git checkout` };
  if (options.rev === undefined && hasNoCommits(options.repoRoot)) return { ok: true, value: new Map() };
  const log = runFirstSeenLog(options.repoRoot, options.rev);
  if (!log.ok) return log;
  const canonicalRoot = canonicalize(options.repoRoot);
  const firstSeen = new Map<string, number>();
  for (const { epoch, gitPath } of parseFirstSeenLog(log.out)) {
    const rel = rebasePath(resolveRenamedPath(gitPath), gitRoot, canonicalRoot);
    if (rel === null) continue;
    if (options.knownPaths && !options.knownPaths.has(rel)) continue;
    if (!firstSeen.has(rel)) firstSeen.set(rel, epoch); // --reverse, so the first sighting wins
  }
  return { ok: true, value: firstSeen };
}

/** (commit epoch, touched path) rows from `%H%x09%ct` headers followed by `--name-only` paths. */
export function parseFirstSeenLog(text: string): { epoch: number; gitPath: string }[] {
  const out: { epoch: number; gitPath: string }[] = [];
  let epoch = 0;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trimEnd();
    if (!line) continue;
    const parts = line.split("\t");
    if (parts.length === 2 && COMMIT_HASH_RE.test(parts[0]!)) {
      epoch = Number(parts[1]);
      continue;
    }
    if (epoch) out.push({ epoch, gitPath: line });
  }
  return out;
}

/** `--reverse` so the first time a path is seen is its birth; `--no-renames` keeps name lines bare. */
function runFirstSeenLog(repoRoot: string, rev?: string): GitLargeResult {
  const args = ["log", "--reverse", "--no-merges", "--no-renames", "--name-only", "--pretty=format:%H%x09%ct", ...revArgs(rev)];
  return runGitLargeResult(repoRoot, args, 128 * 1024 * 1024);
}
