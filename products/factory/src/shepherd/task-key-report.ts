import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { resolveTaskKey, type TaskKeyRefusal } from "@titan-design/pm";
import { z } from "zod";
import type { TaskIndexLookup } from "./task-ref.js";

/** Stands in for an initiative an agent may not read, so the report counts the row without naming it. */
const OWNER_ONLY = "<owner-only>";

interface RegistrationTask {
  runId: string;
  task: string;
}

interface TaskKeyReportRow extends RegistrationTask {
  /** Why the stored key is not canonical: a refusal reason, or `bare` for a key that resolves only once rewritten. */
  reason: TaskKeyRefusal | "bare";
  /** The canonical key the id alone resolves to, or null for no match. */
  proposed: string | null;
}

interface TaskKeyReport {
  total: number;
  resolved: number;
  proposed: number;
  noMatch: number;
  /** Of `proposed`, the rows whose mapping points at an owner-only initiative. */
  ownerOnly: number;
  rows: TaskKeyReportRow[];
}

const RegistrationRow = z.object({ runId: z.string(), task: z.string() });

/** Every registration's task key, through a `mode=ro` URI: SQLite itself refuses any write on this connection. */
export function readRegistrationTasks(dbPath: string): RegistrationTask[] {
  const uri = pathToFileURL(dbPath);
  uri.searchParams.set("mode", "ro");
  const db = new DatabaseSync(uri);
  try {
    return db.prepare("select run_id as runId, task from shepherd_registration order by created_at, run_id").all().map((row) => RegistrationRow.parse(row));
  } finally {
    db.close();
  }
}

function hidden(key: string, agentVisible: ReadonlySet<string>): string {
  const at = key.indexOf("/");
  return agentVisible.has(key.slice(0, at)) ? key : `${OWNER_ONLY}${key.slice(at)}`;
}

function classify(row: RegistrationTask, lookup: TaskIndexLookup): TaskKeyReportRow | null {
  const resolved = resolveTaskKey(row.task, lookup.index);
  if (resolved.ok && resolved.key === row.task) return null;
  const proposed = resolved.ok ? resolved.key : resolved.proposed;
  return { ...row, reason: resolved.ok ? "bare" : resolved.reason, proposed: proposed === undefined ? null : hidden(proposed, lookup.agentVisible) };
}

/** Each registration whose task key is not canonical, with the key it would resolve to; it reads and proposes, and rewrites nothing. */
export function taskKeyReport(registrations: readonly RegistrationTask[], lookup: TaskIndexLookup): TaskKeyReport {
  const rows = registrations.map((row) => classify(row, lookup)).filter((row) => row !== null);
  const proposed = rows.filter((row) => row.proposed !== null);
  return {
    total: registrations.length,
    resolved: registrations.length - rows.length,
    proposed: proposed.length,
    noMatch: rows.length - proposed.length,
    ownerOnly: proposed.filter((row) => row.proposed!.startsWith(OWNER_ONLY)).length,
    rows,
  };
}

export function formatTaskKeyReport(report: TaskKeyReport): string {
  const lines = report.rows.map((row) => `${row.runId}  ${row.task}  ->  ${row.proposed ?? "no match"}  (${row.reason})`);
  const counts = `total ${report.total}  resolved ${report.resolved}  proposed ${report.proposed} (owner-only ${report.ownerOnly})  no match ${report.noMatch}`;
  return `${[...lines, counts].join("\n")}\n`;
}
