import { createHash } from "node:crypto";
import type { OpenPrList } from "./pr-list.js";
import type { RefRead, RulesetList } from "./conditional-reads.js";
import type { PullRequest } from "./port.js";
import type { FakeGitHub } from "./fake-types.js";

/** Like GitHub's list: rows carry no mergeable state or `behind`, so the ETag changes only with what a row shows. */
export function revalidateOpenPrs(fake: FakeGitHub, prs: Map<number, PullRequest>, etag: string | null): OpenPrList {
  const rows = [...prs.values()].filter((pr) => pr.state === "open").map((pr) => ({ ...pr, mergeableState: "unknown", behind: false }));
  const current = etagOf(rows);
  if (notModified(fake, etag, current)) return { notModified: true };
  return { notModified: false, prs: rows, etag: current };
}

/** Like GitHub's 404 for a missing branch, a branch the fake lacks reads as a null sha with no ETag. */
export function revalidateRef(fake: FakeGitHub, branch: string, etag: string | null): RefRead {
  const sha = fake.refs.get(branch);
  if (sha === undefined) return { notModified: false, sha: null, etag: null };
  const current = etagOf(sha);
  if (notModified(fake, etag, current)) return { notModified: true };
  return { notModified: false, sha, etag: current };
}

export function revalidateRulesets(fake: FakeGitHub, etag: string | null): RulesetList {
  if (fake.rulesetsFreePlan) return { notModified: false, unreadable: true };
  const rulesets = Object.fromEntries(fake.rulesets);
  const current = etagOf(rulesets);
  if (notModified(fake, etag, current)) return { notModified: true };
  return { notModified: false, unreadable: false, rulesets, etag: current };
}

const etagOf = (value: unknown): string => `W/"${createHash("sha1").update(JSON.stringify(value)).digest("hex")}"`;

function notModified(fake: FakeGitHub, etag: string | null, current: string): boolean {
  if (etag !== current) return false;
  fake.notModified += 1;
  return true;
}
