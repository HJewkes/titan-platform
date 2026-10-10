import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** The factory.sqlite3 tables the corpus reads, as the factory creates them (columns it does not read are left out). */
const SCHEMA = `
  create table workflow_run (id text primary key, workflow_name text not null, params text not null, status text not null, step_results text not null default '{}', started_at text not null);
  create table shepherd_registration (repo text not null, pr integer, run_id text not null unique, task text not null, implementer text not null, policy text not null, kind text not null, created_at text not null, updated_at text not null);
  create table hitl_gate (id text primary key, prompt text not null, status text not null, payload text, reason text, created_at text not null, resolved_by text);
`;

type StepShape = "output-string" | "output-object" | "data-only";

export interface FixtureStep {
  key: string;
  completedAt: string;
  result: unknown;
  shape?: StepShape;
}

export interface FixtureRun {
  id: string;
  repo: string;
  pr: number;
  kind?: string;
  steps: FixtureStep[];
}

export interface FixtureGate {
  runId: string;
  decision: "merge" | "abandon";
  headSha: string;
  reason: string | null;
  /** Defaults to `owner-terminal`; the owner answering from Matrix is `owner-remote`. */
  resolverClass?: string;
}

function stepValue(step: FixtureStep): Record<string, unknown> {
  const envelope = { result: step.result, v: 1 };
  const base = { stepId: step.key, iteration: 0, operation: "dispatch", completedAt: step.completedAt };
  if (step.shape === "output-object") return { ...base, output: envelope };
  if (step.shape === "data-only") return { ...base, data: envelope };
  return { ...base, output: JSON.stringify(envelope), data: envelope };
}

function insertRun(db: DatabaseSync, run: FixtureRun): void {
  const steps = Object.fromEntries(run.steps.map((step) => [step.key, stepValue(step)]));
  const params = JSON.stringify({ repo: run.repo, pr: String(run.pr), policy: "{}", task: `T/${run.pr}` });
  db.prepare("insert into workflow_run values (?, 'shepherd-pr', ?, 'done', ?, '2026-01-01T00:00:00.000Z')").run(run.id, params, JSON.stringify(steps));
  db.prepare("insert into shepherd_registration values (?, ?, ?, ?, 'impl', '{}', ?, 'x', 'x')").run(run.repo.toLowerCase(), run.pr, run.id, `T/${run.pr}`, run.kind ?? "feature");
}

function insertGate(db: DatabaseSync, gate: FixtureGate, index: number): void {
  const resolvedBy = JSON.stringify({ class: gate.resolverClass ?? "owner-terminal", id: "owner", channel: "factory-cli" });
  db.prepare("insert into hitl_gate values (?, 'merge?', 'resolved', ?, ?, 'x', ?)").run(
    `${gate.runId}/approve-merge:${index}`,
    JSON.stringify({ decision: gate.decision, headSha: gate.headSha }),
    gate.reason,
    resolvedBy,
  );
}

/** Writes a WAL-mode database like the live one, so a read-only open has a `-shm` to deal with. */
export function writeFactoryDb(path: string, runs: readonly FixtureRun[], gates: readonly FixtureGate[] = []): void {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("pragma journal_mode = WAL");
  db.exec(SCHEMA);
  for (const run of runs) insertRun(db, run);
  gates.forEach((gate, index) => insertGate(db, gate, index));
  db.close();
}

export interface ScratchRepo {
  dir: string;
  git(args: string[], at?: string): string;
  /** Writes the files, commits them at `at` and returns the commit sha. */
  commit(files: Record<string, string>, message: string, at: string): string;
}

export function scratchRepo(dir: string): ScratchRepo {
  mkdirSync(dir, { recursive: true });
  const git = (args: string[], at = "2026-01-01T00:00:00Z") =>
    execFileSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid", GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at },
    }).trim();
  git(["init", "-q", "-b", "main"]);
  return {
    dir,
    git,
    commit: (files, message, at) => {
      for (const [path, text] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), text);
      }
      git(["add", "-A"]);
      git(["commit", "-q", "--allow-empty", "-m", message], at);
      return git(["rev-parse", "HEAD"]);
    },
  };
}

export const lines = (count: number, tag = "line"): string => Array.from({ length: count }, (_, i) => `${tag} ${i + 1}`).join("\n") + "\n";
