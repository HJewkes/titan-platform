import type { Ancestry } from "./compare.js";
import type { GhResult, GitExec } from "./exec.js";
import type { Commit, PullRequest } from "./port.js";

/** What the fake's history is made of: created commits with their parents, ref tips and PR heads. */
interface FakeHistory {
  commits: Map<string, Commit>;
  refs: Map<string, string>;
  prs: Map<number, PullRequest>;
}

/** Like GitHub's compare `status`, walked over the fake's parent links; a sha it never saw is `missing`, as a 404 is. */
export function fakeAncestry(history: FakeHistory, base: string, head: string): Ancestry {
  const known = knownShas(history);
  const from = history.refs.get(base) ?? base;
  const to = history.refs.get(head) ?? head;
  if (!known.has(from) || !known.has(to)) return "missing";
  if (from === to) return "identical";
  if (ancestorsOf(history.commits, to).has(from)) return "ahead";
  if (ancestorsOf(history.commits, from).has(to)) return "behind";
  return "diverged";
}

function knownShas(history: FakeHistory): Set<string> {
  const known = new Set([...history.refs.values(), ...[...history.prs.values()].map((pr) => pr.headSha)]);
  for (const commit of history.commits.values()) for (const sha of [commit.sha, ...commit.parents]) known.add(sha);
  return known;
}

function ancestorsOf(commits: Map<string, Commit>, sha: string): Set<string> {
  const seen = new Set<string>();
  const queue = [...(commits.get(sha)?.parents ?? [])];
  for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
    if (seen.has(next)) continue;
    seen.add(next);
    queue.push(...(commits.get(next)?.parents ?? []));
  }
  return seen;
}

const PULL_HEAD = /^refs\/pull\/(\d+)\/head$/;

/** Answers `git ls-remote <url> refs/pull/<n>/head` the way git prints it: one line for a PR the fake has, nothing for one it lacks. */
export function fakeLsRemote(prs: Map<number, PullRequest>, before: () => void): GitExec {
  return async (args): Promise<GhResult> => {
    before();
    const ref = args.at(-1) ?? "";
    const match = PULL_HEAD.exec(ref);
    if (args[0] !== "ls-remote" || !match) return { code: 129, stdout: "", stderr: `fake git: unsupported ${args.join(" ")}` };
    const pr = prs.get(Number(match[1]));
    return { code: 0, stdout: pr ? `${pr.headSha}\t${ref}\n` : "", stderr: "" };
  };
}
