import type { GitHubPort, RepoSlug } from "@titan-design/github";
import { z } from "zod";
import { statusOf } from "./required-checks.js";

const CHECKS_POLICY_PATH = ".github/required-checks.json";

const policyFile = z.strictObject({
  version: z.literal(1),
  branches: z.record(z.string(), z.strictObject({ contexts: z.array(z.string()) })),
});

type ChecksPolicyRead = { readable: true; contexts: string[] } | { readable: false; reason: string };

interface ChecksDrift {
  missing: string[];
  extra: string[];
}

function unreadable(repo: RepoSlug, baseRef: string, why: string): ChecksPolicyRead {
  return { readable: false, reason: `required-checks policy ${CHECKS_POLICY_PATH} of ${repo}@${baseRef} is unreadable: ${why}` };
}

function parseContexts(content: string, baseRef: string): { contexts: string[] } | { why: string } {
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch {
    return { why: "the file is not valid JSON" };
  }
  const parsed = policyFile.safeParse(json);
  if (!parsed.success) return { why: "the file does not match the policy shape" };
  const branch = Object.hasOwn(parsed.data.branches, baseRef) ? parsed.data.branches[baseRef] : undefined;
  return branch ? { contexts: branch.contexts } : { why: `the file does not list branch ${baseRef}` };
}

/** Read at the PR's base ref so the PR under review never decides its own policy. Absent, malformed or unlisted is unreadable, never "no policy". */
export async function readChecksPolicy(port: GitHubPort, repo: RepoSlug, baseRef: string): Promise<ChecksPolicyRead> {
  let file;
  try {
    file = await port.getFile(repo, CHECKS_POLICY_PATH, baseRef);
  } catch (error) {
    return unreadable(repo, baseRef, statusOf(error));
  }
  if (!file) return unreadable(repo, baseRef, `no ${CHECKS_POLICY_PATH} at that ref`);
  const result = parseContexts(file.content, baseRef);
  return "why" in result ? unreadable(repo, baseRef, result.why) : { readable: true, contexts: result.contexts };
}

/** Compares as sets: two rulesets that aggregate can repeat a context, and that is not drift. */
export function checksDrift(expected: readonly string[], live: readonly string[]): ChecksDrift {
  const expectedSet = new Set(expected);
  const liveSet = new Set(live);
  return { missing: [...expectedSet].filter((name) => !liveSet.has(name)), extra: [...liveSet].filter((name) => !expectedSet.has(name)) };
}
