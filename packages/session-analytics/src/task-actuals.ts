import type { Db } from "@titan-design/store-sqlite";
import { workerRole, type WorkerRole } from "./roles.js";
import {
  readAssignmentCounts,
  readOriginsOf,
  readPrSessions,
  readSessionPrs,
  readSessionStats,
  readTaskOrigins,
  type OriginLink,
  type SessionStats,
} from "./task-actuals-queries.js";

export const DEFAULT_ACTIVE_CAP_MINUTES = 15;
const SHORT_CAP_MINUTES = 5;
const LONG_CAP_MINUTES = 60;
const MS_PER_HOUR = 3_600_000;
const WEAK_SOURCES: ReadonlySet<string> = new Set(["brief-paragraph", "brief-anchor"]);

export type TaskActualsFlag = "no-impl-session" | "weak-link" | "multi-task" | "reopened" | "unpriced";

/** A done task as the caller read it from its task store. */
export interface ActualsTask {
  id: string;
  initiative: string;
  /** An ISO datetime, or a date alone for tasks written before the store kept the time. */
  doneAt: string | null;
}

export interface TaskActualsOptions {
  /** Engineering initiatives to read. A task outside it never gets a row. */
  initiatives: readonly string[];
  /** The idle cap behind the headline hours; the 5 and 60 minute values always come alongside. */
  capMinutes?: number;
}

/** Agent-hours at three idle caps. */
export interface CappedHours {
  capped: number;
  at5m: number;
  at60m: number;
}

export interface TaskPr {
  prRef: string;
  mergedAt: string | null;
}

export interface TaskActuals {
  taskId: string;
  initiative: string;
  doneAt: string;
  implAgentHours: CappedHours;
  reviewAgentHours: CappedHours;
  usd: number;
  implSessions: number;
  firstImplAt: string | null;
  lastImplAt: string | null;
  prs: TaskPr[];
  flags: TaskActualsFlag[];
}

interface SessionRecord {
  origin: OriginLink;
  role: WorkerRole;
  stats: SessionStats;
}

interface Contribution {
  record: SessionRecord;
  /** Tasks the session is attributed to; its hours split evenly across them. */
  share: number;
}

/** One row per done task in the allowlist; a task no session links to still gets a row, flagged. */
export function taskActuals(minerDb: Db, tasks: readonly ActualsTask[], options: TaskActualsOptions): TaskActuals[] {
  const allowed = new Set(options.initiatives);
  const done = tasks.filter((t): t is ActualsTask & { doneAt: string } => t.doneAt !== null && allowed.has(t.initiative));
  const wanted = new Set(done.map((t) => t.id));
  const caps = [options.capMinutes ?? DEFAULT_ACTIVE_CAP_MINUTES, SHORT_CAP_MINUTES, LONG_CAP_MINUTES];
  const origins = readTaskOrigins(minerDb).filter((o) => o.taskIds.some((id) => wanted.has(id)));
  const records = buildRecords(minerDb, origins, caps);
  const attached = attachByName(records, wanted);
  attachReviewersByPr(minerDb, records, attached, wanted, caps);
  return done.map((task) => rowFor(task, attached, minerDb));
}

function buildRecords(db: Db, origins: readonly OriginLink[], caps: readonly number[]): Map<string, SessionRecord> {
  const ids = origins.map((o) => o.sessionId);
  const stats = new Map(readSessionStats(db, ids, caps).map((s) => [s.sessionId, s]));
  const assignments = readAssignmentCounts(db, ids);
  const records = new Map<string, SessionRecord>();
  for (const origin of origins) {
    const s = stats.get(origin.sessionId);
    if (!s) continue;
    const lifetimeMs = Date.parse(s.lastTs) - Date.parse(s.firstTs);
    const role = workerRole({ profile: origin.profile, lifetimeMs, assignments: assignments.get(origin.sessionId) ?? 0 });
    records.set(origin.sessionId, { origin, role, stats: s });
  }
  return records;
}

type Attachments = Map<string, Map<string, SessionRecord>>;

function attach(attached: Attachments, taskId: string, record: SessionRecord): void {
  const bySession = attached.get(taskId) ?? new Map<string, SessionRecord>();
  bySession.set(record.origin.sessionId, record);
  attached.set(taskId, bySession);
}

function attachByName(records: ReadonlyMap<string, SessionRecord>, wanted: ReadonlySet<string>): Attachments {
  const attached: Attachments = new Map();
  for (const record of records.values()) {
    for (const id of record.origin.taskIds) if (wanted.has(id)) attach(attached, id, record);
  }
  return attached;
}

/** A reviewer is often linked to the PR and not to the task id, so it joins every task whose implementer linked that PR. */
function attachReviewersByPr(db: Db, records: Map<string, SessionRecord>, attached: Attachments, wanted: ReadonlySet<string>, caps: readonly number[]): void {
  const prTasks = new Map<string, Set<string>>();
  for (const [taskId, sessions] of attached) {
    const implIds = [...sessions.values()].filter((r) => r.role === "implementer").map((r) => r.origin.sessionId);
    for (const link of readSessionPrs(db, implIds)) prTasks.set(link.prRef, (prTasks.get(link.prRef) ?? new Set()).add(taskId));
  }
  const linked = readPrSessions(db, [...prTasks.keys()]);
  const unknown = [...new Set(linked.map((l) => l.sessionId))].filter((id) => !records.has(id));
  for (const [id, record] of buildRecords(db, readOriginsOf(db, unknown), caps)) records.set(id, record);
  for (const { prRef, sessionId } of linked) {
    const record = records.get(sessionId);
    if (record?.role !== "reviewer") continue;
    for (const taskId of prTasks.get(prRef) ?? []) if (wanted.has(taskId)) attach(attached, taskId, record);
  }
}

/** Every task a session is attributed to, named by its spawn record or reached through a PR. */
function shareOf(record: SessionRecord, attached: Attachments): number {
  const tasks = new Set(record.origin.taskIds);
  for (const [taskId, sessions] of attached) if (sessions.has(record.origin.sessionId)) tasks.add(taskId);
  return Math.max(1, tasks.size);
}

function hoursOf(items: readonly Contribution[]): CappedHours {
  const sum = (index: number) => items.reduce((acc, c) => acc + c.record.stats.activeMs[index]! / c.share, 0) / MS_PER_HOUR;
  return { capped: sum(0), at5m: sum(1), at60m: sum(2) };
}

function rowFor(task: ActualsTask & { doneAt: string }, attached: Attachments, db: Db): TaskActuals {
  const all = [...(attached.get(task.id)?.values() ?? [])].map((record): Contribution => ({ record, share: shareOf(record, attached) }));
  const impl = all.filter((c) => c.record.role === "implementer");
  const review = all.filter((c) => c.record.role === "reviewer");
  const used = [...impl, ...review];
  const starts = impl.map((c) => c.record.stats.firstTs).sort();
  const prs = collectPrs(db, impl);
  return {
    taskId: task.id,
    initiative: task.initiative,
    doneAt: task.doneAt,
    implAgentHours: hoursOf(impl),
    reviewAgentHours: hoursOf(review),
    usd: used.reduce((acc, c) => acc + c.record.stats.usd / c.share, 0),
    implSessions: impl.length,
    firstImplAt: starts[0] ?? null,
    lastImplAt: impl.map((c) => c.record.stats.lastTs).sort().at(-1) ?? null,
    prs,
    flags: flagsFor(task.doneAt, impl, used),
  };
}

function collectPrs(db: Db, impl: readonly Contribution[]): TaskPr[] {
  const byRef = new Map<string, TaskPr>();
  for (const link of readSessionPrs(db, impl.map((c) => c.record.origin.sessionId))) {
    byRef.set(link.prRef, { prRef: link.prRef, mergedAt: link.mergedAt });
  }
  return [...byRef.values()].sort((a, b) => a.prRef.localeCompare(b.prRef));
}

function flagsFor(doneAt: string, impl: readonly Contribution[], used: readonly Contribution[]): TaskActualsFlag[] {
  const flags: TaskActualsFlag[] = [];
  if (impl.length === 0) flags.push("no-impl-session");
  if (used.some((c) => WEAK_SOURCES.has(c.record.origin.taskSource ?? ""))) flags.push("weak-link");
  if (used.some((c) => c.share > 1)) flags.push("multi-task");
  const cutoff = doneCutoff(doneAt);
  if (impl.some((c) => Date.parse(c.record.stats.firstTs) > cutoff)) flags.push("reopened");
  if (used.some((c) => c.record.stats.unpriced > 0)) flags.push("unpriced");
  return flags;
}

/** A date-only `done_at` covers its whole UTC day, so only a session starting after that day reopens the task. */
function doneCutoff(doneAt: string): number {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(doneAt);
  return dateOnly ? Date.parse(`${doneAt}T23:59:59.999Z`) : Date.parse(doneAt);
}
