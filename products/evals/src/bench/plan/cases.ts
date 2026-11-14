import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { readOnlyUri } from "../../corpus/factory-db.js";
import { hashCanonical, sha256Hex } from "../../hash.js";
import { leaksAnswer } from "../../implement-task/select.js";
import type { BenchCase } from "../runner.js";

export interface TaskRecord {
  id: string;
  title: string;
  doneWhen: string | null;
  status: string;
  created: string;
  estimate: number | null;
  notes: string;
}

export interface Registration {
  pr: number;
  taskId: string;
  kind: string;
}

interface FileChange {
  path: string;
  lines: number;
}

export interface MainCommit {
  sha: string;
  parent: string;
  date: string;
  subject: string;
  files: FileChange[];
}

/** One merged PR of a task, with the main commit that landed it. */
interface Landing {
  pr: number;
  kind: string;
  commit: MainCommit;
}

const LandedSchema = z.strictObject({ pr: z.number().int(), mergeSha: z.string(), title: z.string() });
export const PlanCaseSchema = z.strictObject({
  id: z.string(),
  hash: z.string(),
  stratum: z.strictObject({ pool: z.enum(["multi", "single"]), kind: z.string() }),
  title: z.string(),
  doneWhen: z.string(),
  kind: z.string(),
  pool: z.enum(["multi", "single"]),
  baseSha: z.string(),
  landed: z.array(LandedSchema).min(1),
  slicesLanded: z.number().int().positive(),
  packages: z.array(z.string()),
  topDirs: z.array(z.string()),
});
export type PlanCase = z.infer<typeof PlanCaseSchema> & BenchCase;
type Pool = PlanCase["pool"];

const TaskYaml = z.looseObject({
  id: z.string().regex(/^TP-\d+$/),
  title: z.unknown(),
  done_when: z.unknown().optional(),
  status: z.unknown().optional(),
  created: z.unknown().optional(),
  estimate: z.unknown().optional(),
  notes: z.unknown().optional(),
});

const text = (value: unknown): string => (typeof value === "string" ? value : value instanceof Date ? value.toISOString() : "");

/** Every parseable `*.yml` task file in the dir; a file that is not a task is skipped, not fatal. */
export function loadTasks(dir: string): Map<string, TaskRecord> {
  const tasks = new Map<string, TaskRecord>();
  for (const name of readdirSync(dir).filter((file) => file.endsWith(".yml"))) {
    let raw: unknown;
    try {
      raw = parseYaml(readFileSync(join(dir, name), "utf8"));
    } catch {
      continue;
    }
    const parsed = TaskYaml.safeParse(raw);
    if (!parsed.success) continue;
    const task = parsed.data;
    const doneWhen = text(task.done_when).trim();
    const estimate = typeof task.estimate === "number" ? task.estimate : null;
    tasks.set(task.id, { id: task.id, title: text(task.title), doneWhen: doneWhen === "" ? null : doneWhen, status: text(task.status), created: text(task.created), estimate, notes: text(task.notes) });
  }
  return tasks;
}

const RegistrationRow = z.object({ pr: z.number().int(), task: z.string(), kind: z.string() });

/** Shepherd registrations for one GitHub repo, read through a `mode=ro` connection SQLite itself keeps read-only. */
export function readRegistrations(dbPath: string, repo: string): Registration[] {
  const db = new DatabaseSync(readOnlyUri(dbPath));
  try {
    const rows = db.prepare("select pr, task, kind from shepherd_registration where lower(repo) = lower(?) and pr is not null").all(repo);
    return rows.map((row) => RegistrationRow.parse(row)).map(({ pr, task, kind }) => ({ pr, taskId: task.split("/").at(-1) ?? task, kind }));
  } finally {
    db.close();
  }
}

/** `--first-parent` history with each commit's diff against its first parent, so a merge reads as the PR it landed. */
export const MAIN_LOG_ARGS = (since: string): string[] => ["log", "--first-parent", "--diff-merges=first-parent", "--numstat", `--since=${since}`, "--format=%x1e%H%x09%P%x09%cI%x09%s", "origin/main"];

export function parseMainLog(output: string): MainCommit[] {
  return output
    .split("\x1e")
    .filter((record) => record.trim() !== "")
    .map((record) => {
      const [header = "", ...rest] = record.split("\n");
      const [sha = "", parents = "", date = "", subject = ""] = header.split("\t");
      const files = rest.flatMap((line) => {
        const [added, deleted, path] = line.split("\t");
        return path === undefined ? [] : [{ path, lines: (Number(added) || 0) + (Number(deleted) || 0) }];
      });
      return { sha, parent: parents.split(" ")[0] ?? "", date: date.slice(0, 10), subject, files };
    });
}

/** Each task's merged PRs, oldest first: a main commit whose subject ends `(#N)` with N registered for a task we have. */
export function landingsByTask(commits: readonly MainCommit[], registrations: readonly Registration[], tasks: ReadonlyMap<string, TaskRecord>): Map<string, Landing[]> {
  const byPr = new Map(registrations.map((registration) => [registration.pr, registration]));
  const byTask = new Map<string, Landing[]>();
  for (const commit of [...commits].reverse()) {
    const pr = Number(/\(#(\d+)\)$/.exec(commit.subject)?.[1]);
    const registration = byPr.get(pr);
    if (registration === undefined || !tasks.has(registration.taskId)) continue;
    byTask.set(registration.taskId, [...(byTask.get(registration.taskId) ?? []), { pr, kind: registration.kind, commit }]);
  }
  return byTask;
}

const LINK_IN_TEXT = /(?:split from|slice of|parent:?|part of)\s+(TP-\d+)/gi;
const TITLE_PREFIX = /^(TP-\d+)\b/;

/** A child names its parent by a `TP-N …` title prefix or a split-from / slice-of / part-of note. */
export function childrenByParent(tasks: ReadonlyMap<string, TaskRecord>): Map<string, Set<string>> {
  const children = new Map<string, Set<string>>();
  const link = (parent: string | undefined, child: string) => {
    if (parent === undefined || parent === child || !tasks.has(parent)) return;
    children.set(parent, (children.get(parent) ?? new Set()).add(child));
  };
  for (const task of tasks.values()) {
    for (const match of `${task.title} ${task.notes}`.matchAll(LINK_IN_TEXT)) link(match[1], task.id);
    link(TITLE_PREFIX.exec(task.title)?.[1], task.id);
  }
  return children;
}

const PACKAGE_ROOTS = ["packages/", "products/", "apps/"];
const IGNORED_DIRS = new Set([".changeset"]);

function areasOf(files: readonly FileChange[]): { packages: string[]; topDirs: string[] } {
  const packages = new Set<string>();
  const topDirs = new Set<string>();
  for (const { path } of files) {
    const segments = path.split("/");
    if (segments.length < 2 || IGNORED_DIRS.has(segments[0] ?? "")) continue;
    topDirs.add(segments[0] ?? "");
    if (PACKAGE_ROOTS.some((root) => path.startsWith(root)) && segments.length > 2) packages.add(segments.slice(0, 2).join("/"));
  }
  return { packages: [...packages].sort(), topDirs: [...topDirs].sort() };
}

function majorityKind(landings: readonly Landing[]): string {
  const counts = new Map<string, number>();
  for (const { kind } of landings) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  return [...counts].sort(([a, x], [b, y]) => y - x || a.localeCompare(b))[0]?.[0] ?? "unknown";
}

/** The base is the first parent of the earliest landed merge: main as it stood when the first slice was briefed. */
function toCase(pool: Pool, task: TaskRecord, landings: readonly Landing[]): PlanCase {
  const kind = majorityKind(landings);
  const record = {
    id: task.id,
    stratum: { pool, kind },
    title: task.title,
    doneWhen: task.doneWhen ?? "",
    kind,
    pool,
    baseSha: landings[0]?.commit.parent ?? "",
    landed: landings.map(({ pr, commit }) => ({ pr, mergeSha: commit.sha, title: commit.subject })),
    slicesLanded: pool === "multi" ? landings.length : 1,
    ...areasOf(landings.flatMap(({ commit }) => commit.files)),
  };
  return { ...record, hash: hashCanonical(record) };
}

interface PoolOptions {
  createdSince: string;
  mergedSince: string;
}

/** Parents created on or after the cutoff, every child done, at least two children merged through Shepherd. */
export function multiPool(tasks: ReadonlyMap<string, TaskRecord>, landings: ReadonlyMap<string, Landing[]>, options: PoolOptions): PlanCase[] {
  return [...childrenByParent(tasks)].flatMap(([parentId, childIds]) => {
    const parent = tasks.get(parentId);
    const children = [...childIds].flatMap((id) => tasks.get(id) ?? []);
    const merged = children.filter((child) => landings.has(child.id));
    if (parent === undefined || parent.doneWhen === null || parent.created < options.createdSince || merged.length < 2) return [];
    if (!children.every((child) => child.status === "done")) return [];
    const landed = merged.flatMap((child) => landings.get(child.id) ?? []).sort((a, b) => a.commit.date.localeCompare(b.commit.date));
    return [toCase("multi", parent, landed)];
  });
}

const KINDS = new Set(["correctness", "feature", "refactor", "test-only"]);
const TEST_FILE = /\.test\.(ts|tsx|mjs)$/;

/** The usable I filter, then the L band: estimate 3 or more, or more than 400 changed lines when there is no estimate. */
function isLargeSingle(task: TaskRecord, landing: Landing, mergedSince: string): boolean {
  const { files, date } = landing.commit;
  const lines = files.reduce((sum, file) => sum + file.lines, 0);
  const usable = task.doneWhen !== null && date >= mergedSince && KINDS.has(landing.kind) && files.some((file) => TEST_FILE.test(file.path)) && lines <= 1500 && areasOf(files).packages.length === 1;
  return usable && (task.estimate === null ? lines > 400 : task.estimate >= 3);
}

/** Tasks that landed as exactly one PR; the truth is one slice. */
export function singlePool(tasks: ReadonlyMap<string, TaskRecord>, landings: ReadonlyMap<string, Landing[]>, options: PoolOptions): PlanCase[] {
  return [...landings].flatMap(([taskId, own]) => {
    const task = tasks.get(taskId);
    const [only] = own;
    if (task === undefined || only === undefined || own.length !== 1 || !isLargeSingle(task, only, options.mergedSince)) return [];
    return [toCase("single", task, own)];
  });
}

const BRIEF_LEAK = /#\d{3,}|\b[0-9a-f]{7,40}\b|closed by Shepherd|Follow-up TP-/;

/** The arm sees only the title and `done_when`; either may have been edited after the merge to name the answer. */
export function briefOf(planCase: Pick<PlanCase, "title" | "doneWhen">): string {
  return `${planCase.title}\n${planCase.doneWhen}`;
}

export function briefLeaks(planCase: Pick<PlanCase, "title" | "doneWhen" | "landed">): boolean {
  const brief = briefOf(planCase);
  return BRIEF_LEAK.test(brief) || planCase.landed.some(({ pr, mergeSha }) => leaksAnswer(brief, { pr_number: pr, merge_commit: mergeSha }));
}

/** A seeded hash per case, so a stratum's order is fixed by the seed and a new seed reshuffles it. */
export const drawOrder = (seed: string, cases: readonly PlanCase[]): PlanCase[] =>
  [...cases].sort((a, b) => sha256Hex(`${seed}\0${a.id}`).localeCompare(sha256Hex(`${seed}\0${b.id}`)));
