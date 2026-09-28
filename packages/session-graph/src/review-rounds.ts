import { RELATIONS } from "@titan-design/session-read";
import { REVIEW_TABLE } from "./audit-schema-v8.js";
import type { SessionGraph } from "./graph.js";
import { KIT } from "./schema.js";
import type { Db } from "@titan-design/store-sqlite";

/** Decides from a sender's `session_origin.profile` whether its chat verdicts count. */
export type ReviewerProfilePredicate = (profile: string) => boolean;

/** The default role set: `reviewer`, or any profile ending in `-reviewer`. */
export const isReviewerProfile: ReviewerProfilePredicate = (profile) => profile === "reviewer" || profile.endsWith("-reviewer");

export interface ReviewRoundOptions {
  isReviewerProfile?: ReviewerProfilePredicate;
}

export interface ReviewProjection {
  /** Chat verdicts given a `pr_ref` this pass. */
  resolved: number;
  /** Chat verdicts whose PR is still unknown. */
  unresolved: number;
  /** Reviews ignored for a time that does not parse, plus PRs whose commit times were unusable. */
  invalidTimes: number;
}

/**
 * The number of distinct heads among changes-requested reviews that a later commit answered.
 * A review's head is the count of commits at or before it, so two reviews on one head count once.
 * A review whose time does not parse is ignored. Returns null when any commit time does not
 * parse, because a missing commit would shift every later head.
 */
export function countRounds(changesRequestedAt: readonly string[], commitTimes: readonly string[]): number | null {
  const commits = parseCommitTimes(commitTimes);
  return commits ? answeredHeads(changesRequestedAt, commits).heads.size : null;
}

function parseCommitTimes(commitTimes: readonly string[]): number[] | null {
  const commits = commitTimes.map(Date.parse);
  return commits.some(Number.isNaN) ? null : commits;
}

function answeredHeads(reviewTimes: readonly string[], commits: readonly number[]): { heads: Set<number>; ignored: number } {
  const heads = new Set<number>();
  let ignored = 0;
  for (const ts of reviewTimes) {
    const at = Date.parse(ts);
    if (Number.isNaN(at)) {
      ignored += 1;
      continue;
    }
    const head = commits.filter((c) => c <= at).length;
    if (head < commits.length) heads.add(head);
  }
  return { heads, ignored };
}

/**
 * Resolve each unresolved chat verdict to a PR, then write `review_rounds_chat` and `review_rounds`
 * for every PR. Runs after `enrichPrs`, so forge reviews and commit times are current.
 */
export function projectReviewRounds(graph: SessionGraph, options: ReviewRoundOptions = {}): ReviewProjection {
  const isReviewer = options.isReviewerProfile ?? isReviewerProfile;
  return graph.db.transaction(() => {
    const resolved = resolveChatVerdicts(graph.db);
    const invalidTimes = writeRounds(graph.db, isReviewer);
    const { n } = graph.db.prepare(`SELECT count(*) AS n FROM ${REVIEW_TABLE} WHERE surface = 'chat' AND pr_ref IS NULL`).get() as { n: number };
    return { resolved, unresolved: n, invalidTimes };
  })();
}

interface ChatVerdictRow {
  source_key: string;
  session_id: string | null;
  repo: string | null;
  repo_hint: string | null;
  cwd_repo: string | null;
  number: number;
}

interface Candidate {
  pr_ref: string;
  repo: string;
}

function resolveChatVerdicts(db: Db): number {
  const rows = db.prepare(`SELECT source_key, session_id, repo, repo_hint, cwd_repo, number FROM ${REVIEW_TABLE} WHERE surface = 'chat' AND pr_ref IS NULL`).all() as ChatVerdictRow[];
  const update = db.prepare(`UPDATE ${REVIEW_TABLE} SET pr_ref = ? WHERE source_key = ?`);
  let resolved = 0;
  for (const row of rows) {
    const prRef = resolvePrRef(db, row);
    if (prRef) resolved += update.run(prRef, row.source_key).changes;
  }
  return resolved;
}

/** An exact repo must exist; a hint that matches nothing falls through to the family links and then the sender's repo. */
function resolvePrRef(db: Db, row: ChatVerdictRow): string | null {
  const candidates = db.prepare("SELECT pr_ref, repo FROM pr WHERE number = ? AND repo IS NOT NULL").all(row.number) as Candidate[];
  if (row.repo) return candidates.find((c) => c.repo === row.repo)?.pr_ref ?? null;
  const hinted = candidates.filter((c) => sameRepoName(c.repo, row.repo_hint));
  if (hinted.length === 1) return hinted[0]!.pr_ref;
  const pool = hinted.length > 0 ? hinted : candidates;
  const linked = familyLinks(db, row.session_id);
  const bySibling = pool.filter((c) => linked.has(c.pr_ref));
  if (bySibling.length === 1) return bySibling[0]!.pr_ref;
  const byCwd = (bySibling.length > 0 ? bySibling : pool).filter((c) => sameRepoName(c.repo, row.cwd_repo));
  return byCwd.length === 1 ? byCwd[0]!.pr_ref : null;
}

/** Compares a bare repo name with the last path segment of an `owner/name` repo. */
function sameRepoName(repo: string, name: string | null): boolean {
  return name !== null && repo.split("/").pop()!.toLowerCase() === name.toLowerCase();
}

/** The sender, its parent, and every session that parent spawned, whether the spawn is known from an origin or a transcript. */
const FAMILY_LINKS = `
  WITH parent(id) AS (
    SELECT parent_session_id FROM session_origin WHERE session_id = @sessionId AND parent_session_id IS NOT NULL
    UNION SELECT session_id FROM subagent WHERE child_session_id = @sessionId AND session_id IS NOT NULL
  ), family(id) AS (
    SELECT @sessionId UNION SELECT id FROM parent
    UNION SELECT session_id FROM session_origin WHERE parent_session_id IN (SELECT id FROM parent)
    UNION SELECT child_session_id FROM subagent WHERE session_id IN (SELECT id FROM parent) AND child_session_id IS NOT NULL
    UNION SELECT substr(target_ref, 9) FROM "${KIT.edge}" WHERE relation = '${RELATIONS.SPAWNED}' AND t_expired IS NULL
      AND target_ref LIKE 'session:%' AND source_ref IN (SELECT 'session:' || id FROM parent)
  )
  SELECT DISTINCT target_ref FROM "${KIT.edge}" WHERE relation = '${RELATIONS.LINKED}' AND t_expired IS NULL
    AND source_ref IN (SELECT 'session:' || id FROM family)`;

function familyLinks(db: Db, sessionId: string | null): Set<string> {
  if (!sessionId) return new Set();
  const rows = db.prepare(FAMILY_LINKS).all({ sessionId }) as { target_ref: string }[];
  return new Set(rows.map((r) => r.target_ref));
}

interface PrRoundRow {
  pr_ref: string;
  commit_times: string | null;
  review_rounds_gh: number | null;
}

interface ChangesRequested {
  pr_ref: string;
  surface: string;
  ts: string;
  profile: string | null;
}

const CHANGES_REQUESTED = `
  SELECT r.pr_ref, r.surface, r.ts, o.profile FROM ${REVIEW_TABLE} r LEFT JOIN session_origin o ON o.session_id = r.session_id
  WHERE r.verdict = 'changes_requested' AND r.pr_ref IS NOT NULL`;

/** Returns the count of unusable times met, for the pass summary. */
function writeRounds(db: Db, isReviewer: ReviewerProfilePredicate): number {
  const byPr = new Map<string, ChangesRequested[]>();
  for (const review of db.prepare(CHANGES_REQUESTED).all() as ChangesRequested[]) {
    if (review.surface === "chat" && !(review.profile && isReviewer(review.profile))) continue;
    byPr.set(review.pr_ref, [...(byPr.get(review.pr_ref) ?? []), review]);
  }
  const update = db.prepare("UPDATE pr SET review_rounds_chat = ?, review_rounds = ? WHERE pr_ref = ?");
  let invalidTimes = 0;
  for (const pr of db.prepare("SELECT pr_ref, commit_times, review_rounds_gh FROM pr").all() as PrRoundRow[]) {
    const { chat, total, invalid } = roundsFor(pr, byPr.get(pr.pr_ref) ?? []);
    update.run(chat, total, pr.pr_ref);
    invalidTimes += invalid;
  }
  return invalidTimes;
}

/**
 * Chat heads join the forge count only where no forge review already sits on that head,
 * so a resolver that sends only a count still adds to the chat rounds unchanged.
 */
function roundsFor(pr: PrRoundRow, reviews: readonly ChangesRequested[]): { chat: number | null; total: number | null; invalid: number } {
  const commits = pr.commit_times === null ? null : parseCommitTimes(JSON.parse(pr.commit_times) as string[]);
  if (!commits) return { chat: null, total: pr.review_rounds_gh, invalid: pr.commit_times === null ? 0 : 1 };
  const timesOn = (surface: string) => reviews.filter((r) => r.surface === surface).map((r) => r.ts);
  const forge = answeredHeads(timesOn("github"), commits);
  const chat = answeredHeads(timesOn("chat"), commits);
  const chatOnly = [...chat.heads].filter((head) => !forge.heads.has(head)).length;
  return { chat: chat.heads.size, total: (pr.review_rounds_gh ?? 0) + chatOnly, invalid: forge.ignored + chat.ignored };
}
