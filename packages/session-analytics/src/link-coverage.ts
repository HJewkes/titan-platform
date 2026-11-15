import { KIT } from "@titan-design/session-graph";
import type { Db } from "@titan-design/store-sqlite";
import type { ReportWindow } from "./cost-report-queries.js";
import { roleFromProfile } from "./roles.js";

export interface ImplementerCoverage {
  sessions: number;
  withTasks: number;
  /** A live `linked` edge to a PR ref. */
  withPr: number;
  /** Task ids, a linked PR and a known `pr.state` together. */
  withTaskPrState: number;
  taskShare: number;
  prShare: number;
  outcomeShare: number;
}

export interface ReviewerCoverage {
  sessions: number;
  /** At least one `pr_review` row whose `pr_ref` is resolved. */
  withResolvedReview: number;
  share: number;
}

export interface LinkCoverage {
  window: ReportWindow;
  implementer: ImplementerCoverage;
  reviewer: ReviewerCoverage;
}

interface SessionRow {
  sessionId: string;
  profile: string | null;
  hasTasks: number;
  hasPr: number;
  hasPrState: number;
  hasReview: number;
}

const SESSIONS = `
  SELECT o.session_id AS sessionId, o.profile,
    (o.task_ids IS NOT NULL AND o.task_ids NOT IN ('', '[]', 'null')) AS hasTasks,
    EXISTS (SELECT 1 FROM "${KIT.edge}" e WHERE e.source_ref = 'session:' || o.session_id AND e.relation = 'linked'
      AND e.t_expired IS NULL AND e.target_ref LIKE 'pr:%') AS hasPr,
    EXISTS (SELECT 1 FROM "${KIT.edge}" e JOIN pr p ON p.pr_ref = e.target_ref WHERE e.source_ref = 'session:' || o.session_id
      AND e.relation = 'linked' AND e.t_expired IS NULL AND p.state IS NOT NULL) AS hasPrState,
    EXISTS (SELECT 1 FROM pr_review r WHERE r.session_id = o.session_id AND r.pr_ref IS NOT NULL) AS hasReview
  FROM session_origin o
  WHERE o.profile IS NOT NULL AND EXISTS (
    SELECT 1 FROM request q WHERE q.session_id = o.session_id
      AND (@since IS NULL OR q.ts >= @since) AND (@until IS NULL OR q.ts < @until))
`;

const share = (part: number, whole: number): number => (whole === 0 ? 0 : part / whole);

function isReviewer(profile: string | null): boolean {
  const name = (profile ?? "").toLowerCase();
  return name === "reviewer" || name.endsWith("-reviewer");
}

function implementerCoverage(rows: readonly SessionRow[]): ImplementerCoverage {
  const withTasks = rows.filter((r) => r.hasTasks).length;
  const withPr = rows.filter((r) => r.hasPr).length;
  const withTaskPrState = rows.filter((r) => r.hasTasks && r.hasPr && r.hasPrState).length;
  const sessions = rows.length;
  return {
    sessions,
    withTasks,
    withPr,
    withTaskPrState,
    taskShare: share(withTasks, sessions),
    prShare: share(withPr, sessions),
    outcomeShare: share(withTaskPrState, sessions),
  };
}

function reviewerCoverage(rows: readonly SessionRow[]): ReviewerCoverage {
  const withResolvedReview = rows.filter((r) => r.hasReview).length;
  return { sessions: rows.length, withResolvedReview, share: share(withResolvedReview, rows.length) };
}

/** How many sessions active in the window carry the links retrieval needs: task, PR and outcome for implementers, a resolved review for reviewers. */
export function linkCoverage(db: Db, window: ReportWindow): LinkCoverage {
  const rows = db.prepare<[object], SessionRow>(SESSIONS).all(window);
  return {
    window,
    implementer: implementerCoverage(rows.filter((r) => roleFromProfile(r.profile) === "implementer")),
    reviewer: reviewerCoverage(rows.filter((r) => isReviewer(r.profile))),
  };
}
