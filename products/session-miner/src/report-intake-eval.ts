import type { Db } from "@titan-design/store-sqlite";
import { z } from "zod";
import { isCloseout, type IntakeRow } from "./report-intake.js";

/**
 * Joins intake rows to what happened next in the event log. The gold for a report is the first of these
 * after it, before the agent's next report and within the horizon: the coordinator messaged the agent, the
 * agent was resumed, or it was retired. A resume is logged under the CLI caller, which can be Shepherd's
 * fix round as well as the coordinator, so the strict match counts every resume and the attributed match
 * only resumes logged under the coordinator's own name.
 */

const GOLD_HORIZON_MS = 12 * 3_600_000;

const NEXT_ACTION_SQL = [
  `SELECT kind, actor FROM events WHERE id > @id AND ts < @until AND target = @agent`,
  `AND ((kind = 'message' AND actor = @coordinator) OR kind IN ('agent_resumed', 'agent_retired')) ORDER BY id LIMIT 1`,
].join(" ");

const NEXT_REPORT_SQL = `SELECT min(ts) AS ts FROM events WHERE id > @id AND kind = 'message' AND actor = @agent AND body LIKE 'Status:%'`;

const nextAction = z.object({ kind: z.string(), actor: z.string() }).optional();
const nextReport = z.object({ ts: z.number().nullable() });

type Gold = "retired" | "resumed" | "messaged" | "left";

interface GoldRow {
  eventId: number;
  closeout: boolean;
  gold: Gold;
  /** The resume or message came from the coordinator itself, not another CLI caller. */
  byCoordinator: boolean;
}

export function goldFor(db: Db, row: IntakeRow): GoldRow {
  const at = Date.parse(row.at);
  const next = nextReport.parse(db.prepare(NEXT_REPORT_SQL).get({ id: row.eventId, agent: row.agent })).ts;
  const until = Math.min(at + GOLD_HORIZON_MS, next ?? Number.MAX_SAFE_INTEGER);
  const action = nextAction.parse(db.prepare(NEXT_ACTION_SQL).get({ id: row.eventId, until, agent: row.agent, coordinator: row.coordinator }));
  const gold: Gold = action === undefined ? "left" : action.kind === "agent_retired" ? "retired" : action.kind === "agent_resumed" ? "resumed" : "messaged";
  return { eventId: row.eventId, closeout: isCloseout(row.actions), gold, byCoordinator: action?.actor === row.coordinator };
}

export interface Agreement {
  reports: number;
  /** Suggested closeout and nobody gave the agent more work. */
  strict: number;
  /** As strict, except a resume not logged under the coordinator's name counts as Shepherd's, which closeout hands the PR to. */
  attributed: number;
  gold: Record<Gold, number>;
}

const reengaged = (row: GoldRow, attributed: boolean): boolean =>
  row.gold === "messaged" || (row.gold === "resumed" && (!attributed || row.byCoordinator));

export function agreement(rows: readonly GoldRow[]): Agreement {
  const gold: Record<Gold, number> = { retired: 0, resumed: 0, messaged: 0, left: 0 };
  for (const row of rows) gold[row.gold] += 1;
  const agrees = (attributed: boolean) => rows.filter((row) => row.closeout !== reengaged(row, attributed)).length;
  return { reports: rows.length, strict: agrees(false), attributed: agrees(true), gold };
}

/** A plain DONE: status DONE, no concerns at all, so the rule table's closeout is the whole suggestion. */
export const isPlainDone = (row: IntakeRow): boolean => row.status === "DONE" && row.concerns.length === 0;
