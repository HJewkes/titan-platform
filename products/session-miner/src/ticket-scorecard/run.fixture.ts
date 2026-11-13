import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openSessionGraph } from "@titan-design/session-graph";
import { openDatabase, type Db } from "@titan-design/store-sqlite";
import { workflowRunTableDdl } from "@titan-design/workflow";
import { stringify } from "yaml";
import type { PerRunRecord } from "./per-run.js";
import type { ScorecardRunOptions } from "./run.js";

/** Synthetic stores for the scorecard job, built in a temp dir. Every name and number here is made up. */
export const INITIATIVE = "alpha";
export const REPO = "acme/widgets";

const FACTORY_DDL = `
  ${workflowRunTableDdl()}
  CREATE TABLE shepherd_registration (repo TEXT NOT NULL, pr INTEGER, run_id TEXT NOT NULL UNIQUE, task TEXT NOT NULL);
  CREATE TABLE shepherd_lineage (run_id TEXT NOT NULL, agent_id TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL, predecessor TEXT, at TEXT NOT NULL, PRIMARY KEY (run_id, agent_id));
  CREATE TABLE hitl_gate (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, resolved_at TEXT, resolved_by TEXT);`;

const EVENTS_DDL = `CREATE TABLE events (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, kind TEXT NOT NULL, actor TEXT NOT NULL, target TEXT, msg_id TEXT, ref TEXT, body TEXT, meta TEXT)`;

interface RunSpec {
  status: string;
  startedAt: string;
  completedAt?: string;
  steps?: { stepId: string; completedAt: string }[];
}

export class ScorecardWorld {
  readonly dir = mkdtempSync(path.join(os.tmpdir(), "ticket-scorecard-"));
  readonly perRun: PerRunRecord[] = [];
  private readonly events: Db;
  private readonly factory: Db;
  private readonly graph: Db;

  constructor() {
    this.events = openDatabase(this.file("events.db"));
    this.events.exec(EVENTS_DDL);
    this.factory = openDatabase(this.file("factory.sqlite3"));
    this.factory.exec(FACTORY_DDL);
    this.graph = openSessionGraph(this.file("graph.sqlite3"), { normalized: true }).db;
    mkdirSync(path.join(this.dir, "root", INITIATIVE, "tasks", "archive"), { recursive: true });
  }

  file(name: string): string {
    return path.join(this.dir, name);
  }

  task(id: string, fields: { created?: string; status?: string; priority?: number; tags?: string[]; archived?: boolean } = {}): void {
    const dir = path.join(this.dir, "root", INITIATIVE, "tasks", fields.archived ? "archive" : "");
    const status = fields.status ?? "open";
    const doneAt = status === "done" ? "2026-11-11T00:00:00Z" : null;
    const created = fields.created ?? "2026-11-01";
    const body = { id, title: `Synthetic task ${id}`, priority: fields.priority ?? 1, status, created, updated: created, done_at: doneAt, tags: fields.tags ?? [] };
    writeFileSync(path.join(dir, `${id}.yml`), stringify(body));
  }

  spawn(taskId: string, at: string, actor = "seat-one", launchedBy?: string, sessionId?: string, model?: string): void {
    const extra = { ...(launchedBy && { launched_by: launchedBy }), ...(sessionId && { session_id: sessionId }), ...(model && { model }) };
    const meta = JSON.stringify({ task: taskId, work_role: "implementer", ...extra });
    this.events.prepare("INSERT INTO events (ts, kind, actor, meta) VALUES (?, 'agent_spawned', ?, ?)").run(Date.parse(at), actor, meta);
  }

  /** A spawn the broker refused. */
  refusal(at: string): void {
    this.events.prepare("INSERT INTO events (ts, kind, actor, meta) VALUES (?, 'agent_spawn_refused', 'seat-one', ?)").run(Date.parse(at), JSON.stringify({ profile: "implementer" }));
  }

  /** A Shepherd gate opened on a run. */
  gate(id: string, createdAt: string): void {
    this.factory.prepare("INSERT INTO hitl_gate (id, created_at) VALUES (?, ?)").run(id, createdAt);
  }

  /** A spawn that recorded no `meta.task`, only the spawned session. */
  untaskedSpawn(sessionId: string, at: string, actor = "seat-one"): void {
    const meta = JSON.stringify({ session_id: sessionId, work_role: "implementer" });
    this.events.prepare("INSERT INTO events (ts, kind, actor, meta) VALUES (?, 'agent_spawned', ?, ?)").run(Date.parse(at), actor, meta);
  }

  /** The session graph's resolved origin link for a session. */
  origin(sessionId: string, taskIds: readonly string[], source: string): void {
    this.graph
      .prepare("INSERT INTO session_origin (session_id, origin_system, task_ids, task_source, resolved_at) VALUES (?, 'agent-chat', ?, ?, '2026-11-10T00:00:00Z')")
      .run(sessionId, taskIds.length === 0 ? null : JSON.stringify(taskIds), source);
  }

  register(taskId: string, pr: number, runId: string, spec: RunSpec): void {
    this.factory.prepare("INSERT INTO shepherd_registration (repo, pr, run_id, task) VALUES (?, ?, ?, ?)").run(REPO, pr, runId, taskId);
    const steps = Object.fromEntries((spec.steps ?? []).map((s) => [s.stepId, { stepId: s.stepId, iteration: 0, completedAt: s.completedAt }]));
    this.factory
      .prepare("INSERT INTO workflow_run (id, workflow_name, params, status, step_results, started_at, completed_at) VALUES (?, 'shepherd-pr', ?, ?, ?, ?, ?)")
      .run(runId, JSON.stringify({ repo: REPO, pr: String(pr), task: taskId }), spec.status, JSON.stringify(steps), spec.startedAt, spec.completedAt ?? null);
    this.perRun.push({ runId, repo: REPO, status: spec.status, completedAt: spec.completedAt ?? null, stageMinutes: { ci: 10, review: 20 }, reviewRounds: 1 });
  }

  addStep(runId: string, stepId: string, completedAt: string): void {
    const row = this.factory.prepare<[string], { step_results: string }>("SELECT step_results FROM workflow_run WHERE id = ?").get(runId)!;
    const steps = { ...JSON.parse(row.step_results), [stepId]: { stepId, iteration: 0, completedAt } };
    this.factory.prepare("UPDATE workflow_run SET step_results = ? WHERE id = ?").run(JSON.stringify(steps), runId);
  }

  successor(runId: string, at: string): void {
    this.factory.prepare("INSERT INTO shepherd_lineage (run_id, agent_id, name, role, at) VALUES (?, ?, 'worker-two', 'successor', ?)").run(runId, `agent-${at}`, at);
  }

  pr(pr: number, fields: { mergedAt?: string; checkedAt: string }): void {
    this.graph
      .prepare("INSERT OR REPLACE INTO pr (pr_ref, number, repo, state, merged_at, outcome_checked_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(`pr:${REPO}#${pr}`, pr, REPO, fields.mergedAt ? "merged" : "open", fields.mergedAt ?? null, fields.checkedAt);
  }

  labels(rows: readonly Record<string, unknown>[]): void {
    writeFileSync(this.file("labels.jsonl"), rows.map((r) => `${JSON.stringify(r)}\n`).join(""));
  }

  options(now: string, overrides: Partial<ScorecardRunOptions> = {}): ScorecardRunOptions {
    const paths = {
      eventsDb: this.file("events.db"),
      factoryDb: this.file("factory.sqlite3"),
      graphDb: this.file("graph.sqlite3"),
      initiativesRoot: path.join(this.dir, "root"),
      initiatives: [INITIATIVE],
      labelsFile: this.file("labels.jsonl"),
    };
    const perRun = [...this.perRun];
    const files = { storeFile: this.file("scorecard.sqlite3"), weeksDir: this.file("weeks"), lockFile: this.file("run.lock") };
    return { paths, ...files, rebuild: false, now: () => new Date(now), perRun: async () => perRun, ...overrides };
  }

  /** The scorecard store's data tables, minus the run log, as one comparable string. */
  dumpStore(): string {
    const db = openDatabase(this.file("scorecard.sqlite3"), { readonly: true });
    try {
      const tables = ["task_row", "week_row", "phase_week", "factory_health_week", "pool_snapshot", "watermark"];
      return JSON.stringify(tables.map((t) => db.prepare(`SELECT * FROM ${t} ORDER BY 1, 2`).all()));
    } finally {
      db.close();
    }
  }

  close(): void {
    for (const db of [this.events, this.factory, this.graph]) db.close();
    rmSync(this.dir, { recursive: true, force: true });
  }
}
