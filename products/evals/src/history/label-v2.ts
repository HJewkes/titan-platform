/**
 * Label v2 of the F6 eval corpus, ported from the Python builder (TP-381) so the TypeScript history build can
 * reproduce `cases.v2.jsonl`. Field names keep the Python snake_case so a stored case compares key for key.
 */

const FOLLOW_UP_DAYS = 14;
export const PER_REPO_LIMIT = 60;

const TASK_ID_RE = /\b(TP|CC|AW|C|R)-(\d+)\b/g;
const RELEASE_RE = /^(version packages|release v?\d|chore\(release\)|chore\(deps)/i;
const FIXUP_RE =
  /^(fixup!|squash!|amend!)|\b(address|apply|fix(es)?|respond to|resolve)\b.{0,24}\b(review|feedback|comments?|nits?|findings?)\b|^fix(es)? (ci|lint|format(ting)?|typecheck|types|tests?|build)\b/i;
const REVIEW_COMMENT_RE =
  /^\s*(#+\s*)?(code )?review\b|\bverdict\b|\bchanges requested\b|\brequest(ed)? changes\b|\bLGTM\b|\bmust[- ]fix\b|\bblocking\b/im;
const FOLLOW_UP_TITLE_RE = /^(fix|hotfix|revert|follow-?up)\b/i;

const DAY_SECONDS = 86400;

interface PrCommit {
  oid: string;
  committedDate: string | null;
  messageHeadline: string;
}

interface PrReview {
  state: string;
  submittedAt: string | null;
}

interface PrComment {
  createdAt: string;
  body: string | null;
}

/** One PR in the shape the Python `from_rest` and `with_details` build; details are absent on excluded PRs. */
export interface WindowPr {
  number: number;
  title: string | null;
  body: string | null;
  state: "OPEN" | "MERGED" | "CLOSED";
  createdAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  headRefName: string | null;
  baseRefName: string | null;
  author: { login: string; is_bot: boolean } | null;
  mergeCommit: { oid: string | null } | null;
  task_ids?: string[];
  files?: string[];
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  reviews?: PrReview[];
  comments?: PrComment[];
  commits?: PrCommit[];
}

type Outcome = "abandoned" | "accepted_first_pass" | "accepted_after_rework";

interface ReworkCommits {
  post_review_commits: number;
  fixup_commits: number;
  rework_commits: number;
}

interface Relatives {
  prior_attempts: number[];
  follow_up_fixes: number[];
  reverted_by: number | null;
}

export interface V2Labels extends ReworkCommits, Relatives {
  rework_count: number;
  outcome: Outcome;
}

/** Epoch seconds, as Python's `datetime.timestamp()`; an empty value is null and an unparseable one throws. */
function ts(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new Error(`not an ISO timestamp: ${value}`);
  return ms / 1000;
}

const tsOf = (value: string): number => ts(value) ?? 0;

/** The first element whose key beats every earlier one, so ties keep the earliest, as Python's `min`/`max` do. */
function bestBy<T>(items: T[], key: (item: T) => number, beats: (a: number, b: number) => boolean): T | null {
  let best: T | null = null;
  let bestKey = 0;
  for (const item of items) {
    const k = key(item);
    if (best === null || beats(k, bestKey)) [best, bestKey] = [item, k];
  }
  return best;
}

function firstReviewAt(pr: WindowPr): number | null {
  const times = (pr.reviews ?? []).map((r) => ts(r.submittedAt));
  for (const c of pr.comments ?? []) if (REVIEW_COMMENT_RE.test(c.body ?? "")) times.push(ts(c.createdAt));
  const known = times.filter((t): t is number => t !== null);
  return known.length ? Math.min(...known) : null;
}

function reworkCommits(pr: WindowPr, reviewAt: number | null): ReworkCommits {
  const afterReview = new Set<string>();
  const fixups = new Set<string>();
  for (const commit of pr.commits ?? []) {
    const committed = ts(commit.committedDate);
    if (reviewAt !== null && committed !== null && committed > reviewAt) afterReview.add(commit.oid);
    if (FIXUP_RE.test(commit.messageHeadline)) fixups.add(commit.oid);
  }
  const rework = new Set([...afterReview, ...fixups]);
  return { post_review_commits: afterReview.size, fixup_commits: fixups.size, rework_commits: rework.size };
}

/** TP-256 Q6 rule: a CHANGES_REQUESTED review counts only when a later commit answered it. */
export function changesRequestedRounds(pr: WindowPr): number {
  const commitTimes = (pr.commits ?? []).flatMap((c) => (c.committedDate ? [tsOf(c.committedDate)] : []));
  const last = commitTimes.length ? Math.max(...commitTimes) : -Infinity;
  return (pr.reviews ?? []).filter((r) => r.state === "CHANGES_REQUESTED" && (ts(r.submittedAt) ?? 0) < last).length;
}

function taskIds(pr: WindowPr): string[] {
  if (pr.task_ids) return pr.task_ids;
  const body = Array.from(pr.body ?? "").slice(0, 2000).join("");
  const text = [pr.title ?? "", pr.headRefName ?? "", body].join(" ");
  return [...new Set(Array.from(text.matchAll(TASK_ID_RE), (m) => m[0]))];
}

const sharesTask = (a: WindowPr, b: WindowPr): boolean => {
  const ids = new Set(taskIds(a));
  return taskIds(b).some((id) => ids.has(id));
};

const isFollowUp = (merged: number | null, other: WindowPr): boolean => {
  const opened = tsOf(other.createdAt);
  return !!merged && merged < opened && opened <= merged + FOLLOW_UP_DAYS * DAY_SECONDS && FOLLOW_UP_TITLE_RE.test(other.title ?? "");
};

/** Label v1: earlier abandoned attempts, later follow-up fixes and reverts on the same task or branch, in this repo. */
function relatives(pr: WindowPr, repoPrs: WindowPr[]): Relatives {
  const created = tsOf(pr.createdAt);
  const merged = ts(pr.mergedAt);
  const prior: number[] = [];
  const followUps: number[] = [];
  let revertedBy: number | null = null;
  for (const other of repoPrs) {
    if (other.number === pr.number) continue;
    if ((other.title ?? "").startsWith(`Revert "${pr.title}"`)) revertedBy = other.number;
    if (!(sharesTask(pr, other) || other.headRefName === pr.headRefName)) continue;
    if (tsOf(other.createdAt) < created && other.state === "CLOSED" && !other.mergedAt) prior.push(other.number);
    if (isFollowUp(merged, other)) followUps.push(other.number);
  }
  const numeric = (a: number, b: number): number => a - b;
  return { prior_attempts: prior.sort(numeric), follow_up_fixes: followUps.sort(numeric), reverted_by: revertedBy };
}

function sameTaskOverlapping(pr: WindowPr, repoPrs: WindowPr[]): WindowPr[] {
  const files = new Set(pr.files ?? []);
  return repoPrs.filter((o) => o.number !== pr.number && sharesTask(pr, o) && (o.files ?? []).some((f) => files.has(f)));
}

/** The nearest merged PR on the follow-up's task, merged before the follow-up opened, whose files overlap it. */
function fixedPr(followUp: WindowPr, repoPrs: WindowPr[]): WindowPr | null {
  const opened = tsOf(followUp.createdAt);
  const candidates = sameTaskOverlapping(followUp, repoPrs).filter((o) => o.mergedAt && tsOf(o.mergedAt) < opened);
  return bestBy(candidates, (o) => tsOf(o.mergedAt ?? ""), (a, b) => a > b);
}

/** The nearest merged PR on the abandoned attempt's task, opened after the attempt, whose files overlap it. */
function supersedingPr(attempt: WindowPr, repoPrs: WindowPr[]): WindowPr | null {
  const opened = tsOf(attempt.createdAt);
  const candidates = sameTaskOverlapping(attempt, repoPrs).filter((o) => o.mergedAt && tsOf(o.createdAt) > opened);
  return bestBy(candidates, (o) => tsOf(o.createdAt), (a, b) => a < b);
}

function attributedTo(relative: WindowPr, pr: WindowPr, target: WindowPr | null): boolean {
  if (target !== null) return target.number === pr.number;
  return !!relative.headRefName && relative.headRefName === pr.headRefName;
}

/** Label v2: each v1 prior attempt and follow-up counts only for the one PR it is attributed to. */
function relativesV2(pr: WindowPr, repoPrs: WindowPr[]): Relatives {
  const rel = relatives(pr, repoPrs);
  const byNumber = new Map(repoPrs.map((o) => [o.number, o]));
  const keep = (target: (relative: WindowPr, prs: WindowPr[]) => WindowPr | null) => (n: number) => {
    const relative = byNumber.get(n);
    return relative !== undefined && attributedTo(relative, pr, target(relative, repoPrs));
  };
  return {
    ...rel,
    prior_attempts: rel.prior_attempts.filter(keep(supersedingPr)),
    follow_up_fixes: rel.follow_up_fixes.filter(keep(fixedPr)),
  };
}

function outcomeLabel(pr: WindowPr, reworkCount: number, revertedBy: number | null): Outcome {
  if (!pr.mergedAt || revertedBy !== null) return "abandoned";
  return reworkCount === 0 ? "accepted_first_pass" : "accepted_after_rework";
}

export function excludedReason(pr: WindowPr): "open" | "bot" | "release" | null {
  if (pr.state === "OPEN") return "open";
  if ((pr.author?.login ?? "").endsWith("[bot]") || pr.author?.is_bot) return "bot";
  if (RELEASE_RE.test(pr.title ?? "")) return "release";
  return null;
}

/** The label fields `build_case` writes for one PR, judged against every PR in its repo's window. */
export function labelV2(pr: WindowPr, repoPrs: WindowPr[]): V2Labels {
  const commits = reworkCommits(pr, firstReviewAt(pr));
  const rel = relativesV2(pr, repoPrs);
  const reworkCount = commits.rework_commits + rel.prior_attempts.length + rel.follow_up_fixes.length;
  return { ...commits, ...rel, rework_count: reworkCount, outcome: outcomeLabel(pr, reworkCount, rel.reverted_by) };
}

function stateAt(pr: WindowPr, cutoff: number): WindowPr {
  if ((ts(pr.closedAt) ?? 0) <= cutoff) return pr;
  return { ...pr, state: "OPEN", mergedAt: null, closedAt: null, mergeCommit: null };
}

/** The `limit` most recent PRs created by `asOf`, each in its state at `asOf`. */
export function pinWindow(prs: WindowPr[], asOf: string, limit: number = PER_REPO_LIMIT): WindowPr[] {
  const cutoff = tsOf(asOf);
  const existing = prs.filter((p) => tsOf(p.createdAt) <= cutoff).sort((a, b) => tsOf(b.createdAt) - tsOf(a.createdAt));
  return existing.slice(0, limit).map((p) => stateAt(p, cutoff));
}
