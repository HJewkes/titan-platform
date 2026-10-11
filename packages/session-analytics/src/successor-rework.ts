import type { Db } from "@titan-design/store-sqlite";
import { z } from "zod";
import { tagSessions } from "./cost-report.js";
import { readAgentNames, readCostRows, readSessionContexts, type CostRow, type ReportWindow } from "./cost-report-queries.js";
import { readRequestToolCalls } from "./request-owner.js";

export const DEFAULT_BOOT_REQUESTS = 30;

const HAS_FILE_READ = `SELECT EXISTS (SELECT 1 FROM session_signal WHERE signal = 'file_read') AS present`;
/** Only `file_read`: a file the predecessor wrote but never read is not something the successor re-learns. */
const SESSION_READS = `SELECT DISTINCT detail FROM session_signal WHERE session_id = @sessionId AND signal = 'file_read' AND detail IS NOT NULL`;

export interface SuccessorReworkOptions {
  /** How many of the successor's first main-thread requests count as its boot. */
  bootRequests?: number;
}

const count = z.number().int().nonnegative();
const mean = z.number().nonnegative();

export const successorReworkSchema = z.object({
  window: z.object({ since: z.string().nullable(), until: z.string().nullable() }),
  bootRequests: z.number().int().positive(),
  /** False when the graph holds no `file_read` signal at all, so zero rework means no data, not no rework. */
  fileReadData: z.boolean(),
  rows: z.array(
    z.object({
      role: z.string(),
      pairs: count,
      meanBootReads: mean,
      meanRereads: mean,
      /** Re-read paths over all boot-read paths across the role's pairs; null when nothing was read. */
      rereadShare: z.number().min(0).max(1).nullable(),
      /** Cost of boot requests that read at least one re-read path, each request once. */
      rereadCostUsd: z.number().nonnegative(),
    }),
  ),
});

export type SuccessorReworkReport = z.infer<typeof successorReworkSchema>;
type RoleRow = SuccessorReworkReport["rows"][number];

interface Span {
  sessionId: string;
  first: string;
  last: string;
  /** Main-thread requests in ts order. */
  requests: CostRow[];
}

interface Pair {
  predecessor: Span;
  successor: Span;
}

interface PairRework {
  bootReads: number;
  rereads: number;
  rereadCostUsd: number;
}

/**
 * Per role, how much of a successor's boot reading re-reads files its same-named predecessor already
 * read. A guardrail proxy for handoff quality, not a cost to minimise.
 */
export function successorReworkReport(db: Db, window: ReportWindow, options: SuccessorReworkOptions = {}): SuccessorReworkReport {
  const bootRequests = options.bootRequests ?? DEFAULT_BOOT_REQUESTS;
  const fileReadData = (db.prepare(HAS_FILE_READ).get() as { present: number }).present === 1;
  const pairs = pairSessions(db, readSpans(db)).filter((pair) => inWindow(pair.successor.first, window));
  if (pairs.length === 0) return { window, bootRequests, fileReadData, rows: [] };
  const calls = readRequestToolCalls(db, { since: window.since, until: null });
  const roles = tagSessions(readSessionContexts(db, pairs.map((pair) => pair.successor.sessionId)));
  const byRole = new Map<string, PairRework[]>();
  for (const pair of pairs) {
    const role = roles.get(pair.successor.sessionId)!.role;
    byRole.set(role, [...(byRole.get(role) ?? []), pairRework(db, pair, bootRequests, calls)]);
  }
  return { window, bootRequests, fileReadData, rows: [...byRole].map(([role, reworks]) => roleRow(role, reworks)) };
}

function readSpans(db: Db): Map<string, Span> {
  const spans = new Map<string, Span>();
  const mainThread = readCostRows(db, { since: null, until: null }).filter((row) => !row.isSidechain);
  for (const row of mainThread.sort((a, b) => a.ts.localeCompare(b.ts))) {
    const span = spans.get(row.sessionId) ?? { sessionId: row.sessionId, first: row.ts, last: row.ts, requests: [] };
    span.last = row.ts;
    span.requests.push(row);
    spans.set(row.sessionId, span);
  }
  return spans;
}

/** Each named session's successor is the next session to start under its name, if that one starts after it ends. */
function pairSessions(db: Db, spans: Map<string, Span>): Pair[] {
  const byName = new Map<string, Span[]>();
  for (const { sessionId, agentName } of readAgentNames(db)) {
    const span = spans.get(sessionId);
    if (span) byName.set(agentName, [...(byName.get(agentName) ?? []), span]);
  }
  const pairs: Pair[] = [];
  for (const sessions of byName.values()) {
    sessions.sort((a, b) => a.first.localeCompare(b.first));
    for (let i = 1; i < sessions.length; i += 1) {
      const [predecessor, successor] = [sessions[i - 1]!, sessions[i]!];
      if (successor.first >= predecessor.last) pairs.push({ predecessor, successor });
    }
  }
  return pairs;
}

function inWindow(ts: string, window: ReportWindow): boolean {
  return (window.since === null || ts >= window.since) && (window.until === null || ts < window.until);
}

function pairRework(db: Db, pair: Pair, bootRequests: number, calls: ReturnType<typeof readRequestToolCalls>): PairRework {
  const predecessorReads = new Set((db.prepare(SESSION_READS).all({ sessionId: pair.predecessor.sessionId }) as { detail: string }[]).map((row) => row.detail));
  const bootReads = new Set<string>();
  const rereads = new Set<string>();
  let rereadCostUsd = 0;
  for (const request of pair.successor.requests.slice(0, bootRequests)) {
    const paths = (calls.get(request.requestId) ?? []).flatMap((call) => call.readPaths ?? []);
    for (const path of paths) bootReads.add(path);
    const reread = paths.filter((path) => predecessorReads.has(path));
    for (const path of reread) rereads.add(path);
    if (reread.length > 0) rereadCostUsd += request.costUsd;
  }
  return { bootReads: bootReads.size, rereads: rereads.size, rereadCostUsd };
}

function roleRow(role: string, reworks: readonly PairRework[]): RoleRow {
  const sum = (pick: (rework: PairRework) => number) => reworks.reduce((total, rework) => total + pick(rework), 0);
  const [bootReads, rereads] = [sum((r) => r.bootReads), sum((r) => r.rereads)];
  return {
    role,
    pairs: reworks.length,
    meanBootReads: bootReads / reworks.length,
    meanRereads: rereads / reworks.length,
    rereadShare: bootReads === 0 ? null : rereads / bootReads,
    rereadCostUsd: sum((r) => r.rereadCostUsd),
  };
}
