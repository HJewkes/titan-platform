import type { Db } from "@titan-design/store-sqlite";
import { z } from "zod";
import { contextBand } from "./bands.js";
import type { ReportWindow } from "./cost-report-queries.js";

const APPROVE = "approve";
const CHANGES_REQUESTED = "changes_requested";
const CHAT_KEY = /^chat:([^:]+):/;

const VERDICTS = `
  SELECT source_key AS sourceKey, verdict, ts, pr_ref AS prRef, transcript_id AS transcriptId FROM pr_review
  WHERE (@since IS NULL OR ts >= @since) AND (@until IS NULL OR ts < @until)
`;
const CHANGES = `SELECT pr_ref AS prRef, ts FROM pr_review WHERE verdict = '${CHANGES_REQUESTED}' AND pr_ref IS NOT NULL`;
/** The ownership rule of request-owner.ts: the latest request at or before the tool use. That module drops the tool use id, so the lookup is repeated here. */
const ISSUER = `
  SELECT r.model, r.context_tokens AS tokens FROM tool_call c
  JOIN request r ON r.transcript_id = c.transcript_id AND r.byte_offset <= c.byte_offset
  WHERE c.tool_use_id = @toolUseId AND c.transcript_id = @transcriptId
  ORDER BY r.byte_offset DESC LIMIT 1
`;

interface VerdictRow {
  sourceKey: string;
  verdict: string;
  ts: string;
  prRef: string | null;
  transcriptId: number | null;
}

interface Issuer {
  model: string;
  tokens: number;
}

const count = z.number().int().nonnegative();
const rate = z.number().min(0).max(1).nullable();

export const reviewFillSchema = z.object({
  window: z.object({ since: z.string().nullable(), until: z.string().nullable() }),
  /** Verdicts with no fill: GitHub-surface reviews, and chat verdicts whose issuing request is not in the graph. */
  unfilled: count,
  /** Verdicts whose `pr_ref` is not resolved; they count in their band but are never matched to another review. */
  unresolved: count,
  rows: z.array(
    z.object({
      band: z.string(),
      model: z.string(),
      verdicts: count,
      changesRequested: count,
      changesRate: rate,
      verdictErrors: count,
      /** Verdict errors over all verdicts in the cell, not over approvals. */
      errorRate: rate,
    }),
  ),
});

export type ReviewFillReport = z.infer<typeof reviewFillSchema>;
type Cell = ReviewFillReport["rows"][number];

/** Review verdicts in the window by the reviewer's context fill when it issued them, and how often an approve was contradicted. */
export function reviewFillReport(db: Db, window: ReportWindow): ReviewFillReport {
  const changesByPr = readChangesByPr(db);
  const cells = new Map<string, Cell>();
  let unfilled = 0;
  let unresolved = 0;
  for (const row of db.prepare(VERDICTS).all(window) as VerdictRow[]) {
    if (!row.prRef) unresolved += 1;
    const issuer = issuerOf(db, row);
    const band = issuer ? contextBand(issuer.tokens) : null;
    if (!issuer || !band) {
      unfilled += 1;
      continue;
    }
    const key = `${band}|${issuer.model}`;
    cells.set(key, tally(cells.get(key) ?? emptyCell(band, issuer.model), row, changesByPr));
  }
  return { window, unfilled, unresolved, rows: [...cells.values()].map(withRates) };
}

function issuerOf(db: Db, row: VerdictRow): Issuer | null {
  const toolUseId = CHAT_KEY.exec(row.sourceKey)?.[1];
  if (!toolUseId || row.transcriptId === null) return null;
  return (db.prepare(ISSUER).get({ toolUseId, transcriptId: row.transcriptId }) as Issuer | undefined) ?? null;
}

function readChangesByPr(db: Db): Map<string, string[]> {
  const byPr = new Map<string, string[]>();
  for (const { prRef, ts } of db.prepare(CHANGES).all() as { prRef: string; ts: string }[]) byPr.set(prRef, [...(byPr.get(prRef) ?? []), ts]);
  return byPr;
}

function tally(cell: Cell, row: VerdictRow, changesByPr: Map<string, string[]>): Cell {
  const contradicted = row.verdict === APPROVE && row.prRef !== null && (changesByPr.get(row.prRef) ?? []).some((ts) => ts > row.ts);
  return {
    ...cell,
    verdicts: cell.verdicts + 1,
    changesRequested: cell.changesRequested + (row.verdict === CHANGES_REQUESTED ? 1 : 0),
    verdictErrors: cell.verdictErrors + (contradicted ? 1 : 0),
  };
}

function emptyCell(band: string, model: string): Cell {
  return { band, model, verdicts: 0, changesRequested: 0, changesRate: null, verdictErrors: 0, errorRate: null };
}

function withRates(cell: Cell): Cell {
  return { ...cell, changesRate: cell.changesRequested / cell.verdicts, errorRate: cell.verdictErrors / cell.verdicts };
}
