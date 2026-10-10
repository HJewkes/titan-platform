import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { z } from "zod";

/** The few factory.sqlite3 columns the corpus reads, so the extractor never depends on the factory's own modules. */
export interface FactoryRun {
  id: string;
  params: string;
  stepResults: string;
}

export interface FactoryRegistration {
  runId: string;
  task: string;
  kind: string;
  policy: string;
}

export interface OwnerGateRow {
  id: string;
  payload: string | null;
  resolvedBy: string | null;
  reason: string | null;
}

export interface FactoryReader {
  runs(): FactoryRun[];
  registrations(): FactoryRegistration[];
  /** Resolved `approve-merge` gates; the id starts with the run id. */
  approveMergeGates(): OwnerGateRow[];
  close(): void;
}

const RunRow = z.object({ id: z.string(), params: z.string(), stepResults: z.string() });
const RegistrationRow = z.object({ runId: z.string(), task: z.string(), kind: z.string(), policy: z.string() });
const GateRow = z.object({ id: z.string(), payload: z.string().nullable(), resolvedBy: z.string().nullable(), reason: z.string().nullable() });

/** A `mode=ro` URI: SQLite itself refuses every write on this connection, whatever a query says. */
export function readOnlyUri(path: string): URL {
  const url = pathToFileURL(path);
  url.searchParams.set("mode", "ro");
  return url;
}

export function openFactoryDb(path: string): FactoryReader {
  const db = new DatabaseSync(readOnlyUri(path));
  const all = <T>(schema: z.ZodType<T>, sql: string): T[] => db.prepare(sql).all().map((row) => schema.parse(row));
  return {
    runs: () => all(RunRow, "select id, params, step_results as stepResults from workflow_run where workflow_name = 'shepherd-pr'"),
    registrations: () => all(RegistrationRow, "select run_id as runId, task, kind, policy from shepherd_registration"),
    approveMergeGates: () =>
      all(GateRow, "select id, payload, resolved_by as resolvedBy, reason from hitl_gate where status = 'resolved' and id like '%/approve-merge%'"),
    close: () => db.close(),
  };
}
