import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { GhError, execGh, type GhExec } from "@titan-design/github";
import { EXIT } from "@titan-design/registry";
import {
  parseDenials,
  parseSeatJournal,
  parseVerdict,
  prKey,
  type DenialRecord,
  type PullState,
  type SeatJournal,
  type VerdictRecord,
} from "@titan-design/session-analytics";
import { openDatabase, type Db } from "@titan-design/store-sqlite";
import { z } from "zod";

interface EventRow {
  id: number;
  ts: number;
  actor: string;
  target: string | null;
  body: string;
}

/** Runs `read` over agent-chat's events table opened read-only; nothing is written, not even a WAL pragma. */
export function withEventsDb<T>(eventsDb: string, read: (db: Db) => T): T {
  if (!existsSync(eventsDb)) throw Object.assign(new Error(`agent-chat events db not found: ${eventsDb} (set TITAN_MINER_EVENTS_DB)`), { code: EXIT.DATAERR });
  const db = openDatabase(eventsDb, { readonly: true, foreignKeys: false });
  try {
    return read(db);
  } finally {
    db.close();
  }
}

/** Verdict messages from agent-chat's events table, and how many `Verdict:` messages parseVerdict refused; window bounds are ISO and inclusive-exclusive, and `seats` limits the refused count to verdicts sent to those seats. */
export function readVerdicts(eventsDb: string, window: { since?: string; until?: string }, seats?: readonly string[]): { verdicts: VerdictRecord[]; unparsed: number } {
  return withEventsDb(eventsDb, (db) => {
    const sql = `SELECT id, ts, actor, target, body FROM events WHERE kind = 'message' AND body LIKE 'Verdict:%' AND ts >= ? AND ts < ? ORDER BY id`;
    const rows = db.prepare(sql).all(window.since ? Date.parse(window.since) : 0, window.until ? Date.parse(window.until) : Number.MAX_SAFE_INTEGER) as EventRow[];
    const verdicts = rows.flatMap((row) => {
      const parsed = parseVerdict(row.body);
      return parsed ? [{ ...parsed, eventId: row.id, at: new Date(row.ts).toISOString(), seat: row.target ?? "", reviewer: row.actor }] : [];
    });
    const inSeats = (row: EventRow) => !seats || seats.includes(row.target ?? "");
    const unparsed = rows.filter((row) => !parseVerdict(row.body) && inSeats(row)).length;
    return { verdicts, unparsed };
  });
}

const ghPull = z.object({ state: z.enum(["open", "closed"]), merged_at: z.string().nullable(), head: z.object({ sha: z.string() }) });

const PULL_CONCURRENCY = 6;

/** Each PR's state from GitHub REST; a PR GitHub cannot find is left out and reported as unknown. */
export async function fetchPulls(keys: readonly { repo: string; pr: number }[], exec: GhExec = execGh): Promise<PullState[]> {
  const unique = [...new Map(keys.map((k) => [prKey(k), k])).values()];
  const pulls: PullState[] = [];
  for (let i = 0; i < unique.length; i += PULL_CONCURRENCY) {
    const batch = await Promise.all(unique.slice(i, i + PULL_CONCURRENCY).map((key) => fetchPull(key, exec)));
    pulls.push(...batch.flatMap((p) => (p ? [p] : [])));
  }
  return pulls;
}

async function fetchPull({ repo, pr }: { repo: string; pr: number }, exec: GhExec): Promise<PullState | null> {
  const args = ["api", `repos/${repo}/pulls/${pr}`];
  const result = await exec(args);
  if (result.code !== 0) {
    if (new GhError(args, result).status === 404) return null;
    throw new GhError(args, result);
  }
  const body = ghPull.parse(JSON.parse(result.stdout));
  return { repo, pr, state: body.state, mergedAt: body.merged_at && new Date(body.merged_at).toISOString(), headSha: body.head.sha };
}

const pullSnapshot = z.array(z.object({ repo: z.string(), pr: z.number().int(), state: z.enum(["open", "closed"]), mergedAt: z.string().nullable(), headSha: z.string() }));

/** A saved array of PR states, so a run can be repeated offline and against a fixed GitHub view. */
export function readPullSnapshot(file: string): PullState[] {
  return pullSnapshot.parse(JSON.parse(readFileSync(file, "utf8")));
}

/** Splits a repeatable `seat=path` flag value. */
export function seatPath(spec: string): { seat: string; file: string } {
  const at = spec.indexOf("=");
  if (at <= 0 || at === spec.length - 1) throw Object.assign(new Error(`expected <seat>=<path>, got "${spec}"`), { code: EXIT.DATAERR });
  return { seat: spec.slice(0, at), file: spec.slice(at + 1) };
}

/** Denials from a seat's transcript file, or from every `.jsonl` file directly inside a directory. */
export function readDenials(spec: string): DenialRecord[] {
  const { seat, file } = seatPath(spec);
  const files = statSync(file).isDirectory() ? readdirSync(file).filter((f) => f.endsWith(".jsonl")).map((f) => path.join(file, f)) : [file];
  return files.flatMap((f) => parseDenials(readFileSync(f, "utf8").split("\n"), seat));
}

const JOURNAL_DATE = /(\d{4}-\d{2}-\d{2})\.md$/;

/** A seat journal named `<YYYY-MM-DD>.md`, whose clock is this machine's local time on that date. */
export function readJournal(spec: string): SeatJournal {
  const { seat, file } = seatPath(spec);
  const date = JOURNAL_DATE.exec(file)?.[1];
  if (!date) throw Object.assign(new Error(`journal file must be named <YYYY-MM-DD>.md: ${file}`), { code: EXIT.DATAERR });
  const utcOffsetMin = -new Date(`${date}T12:00:00`).getTimezoneOffset();
  return parseSeatJournal(readFileSync(file, "utf8"), seat, date, utcOffsetMin);
}
