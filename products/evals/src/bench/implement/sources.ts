import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import YAML from "yaml";
import { z } from "zod";
import { readOnlyUri } from "../../corpus/factory-db.js";

const run = promisify(execFile);

export interface Registration {
  pr: number;
  task: string;
  kind: string;
  createdAt: string;
}

export interface MainMerge {
  pr: number;
  sha: string;
  parent: string;
  mergedAt: string;
}

export interface NumstatLine {
  /** Null for a binary file, whose lines git does not count. */
  changed: number | null;
  path: string;
}

export interface TaskFile {
  title: string;
  doneWhen: string | null;
  estimate: number | null;
}

/** The three sources a case joins; tests replace each with synthetic data. */
export interface CorpusSources {
  registrations(): Registration[];
  mainMerges(): Promise<MainMerge[]>;
  /** Undefined when no task file exists; a file that will not parse throws. */
  task(id: string): TaskFile | undefined;
  numstat(merge: MainMerge): Promise<NumstatLine[]>;
}

/** `$TITAN_FACTORY_DB`, else the factory's own default under the XDG state dir. */
export function defaultFactoryDb(env: NodeJS.ProcessEnv): string {
  if (env.TITAN_FACTORY_DB) return env.TITAN_FACTORY_DB;
  return join(env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "titan-factory", "factory.sqlite3");
}

const RegistrationRow = z.object({ pr: z.number().int(), task: z.string(), kind: z.string(), createdAt: z.string() });

/** Opened `mode=ro`, so SQLite refuses every write; the repo slug is matched case-blind, as Shepherd stored both casings. */
function readRegistrations(dbPath: string, repoSlug: string): Registration[] {
  const db = new DatabaseSync(readOnlyUri(dbPath));
  try {
    const sql = "select pr, task, kind, created_at as createdAt from shepherd_registration where lower(repo) = lower(?) and pr is not null order by created_at";
    return db.prepare(sql).all(repoSlug).map((row) => RegistrationRow.parse(row));
  } finally {
    db.close();
  }
}

async function git(repoDir: string, args: readonly string[]): Promise<string> {
  const { stdout } = await run("git", ["-C", repoDir, ...args], { maxBuffer: 256 * 1024 * 1024 });
  return stdout;
}

const SQUASH_SUBJECT = /\(#(\d+)\)$/;

function parseMainLog(text: string): MainMerge[] {
  return text.split("\n").flatMap((line) => {
    const [sha, parents, mergedAt, subject] = line.split("\t");
    const pr = SQUASH_SUBJECT.exec(subject ?? "")?.[1];
    const parent = parents?.split(" ")[0];
    if (sha === undefined || pr === undefined || !parent || mergedAt === undefined) return [];
    return [{ pr: Number(pr), sha, parent, mergedAt }];
  });
}

function parseNumstat(text: string): NumstatLine[] {
  return text.split("\n").flatMap((line) => {
    const [added, deleted, path] = line.split("\t");
    if (path === undefined || added === undefined || deleted === undefined) return [];
    return [{ changed: added === "-" ? null : Number(added) + Number(deleted), path }];
  });
}

function doneWhenText(value: unknown): string | null {
  if (typeof value === "string" && value.trim() !== "") return value;
  if (Array.isArray(value) && value.length > 0) return value.map((item) => `- ${String(item)}`).join("\n");
  return null;
}

const TaskYml = z.object({ title: z.coerce.string().optional(), done_when: z.unknown().optional(), estimate: z.unknown().optional() });

function readTask(tasksDir: string, id: string): TaskFile | undefined {
  const file = join(tasksDir, `${id}.yml`);
  if (!existsSync(file)) return undefined;
  const parsed = TaskYml.parse(YAML.parse(readFileSync(file, "utf8")) ?? {});
  const estimate = Number(parsed.estimate);
  return { title: parsed.title ?? "", doneWhen: doneWhenText(parsed.done_when), estimate: parsed.estimate == null || !Number.isFinite(estimate) ? null : estimate };
}

interface SourceOptions {
  factoryDb: string;
  repoSlug: string;
  tasksDir: string;
  repoDir: string;
  mainRef: string;
}

export function liveSources(options: SourceOptions): CorpusSources {
  return {
    registrations: () => readRegistrations(options.factoryDb, options.repoSlug),
    mainMerges: async () => parseMainLog(await git(options.repoDir, ["log", "--first-parent", "--format=%H%x09%P%x09%cI%x09%s", options.mainRef])),
    task: (id) => readTask(options.tasksDir, id),
    numstat: async (merge) => parseNumstat(await git(options.repoDir, ["diff", "--numstat", merge.parent, merge.sha])),
  };
}
