import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { z } from "zod";
import type { TaskFacts } from "./classify.js";
import type { FactName, FactsNote } from "./meta.js";
import { planFacts, type PriorRouter, type PriorRouting } from "./prior.js";
import type { RouteTable } from "./route.js";
import { parseWorkflowTable, TABLE_VERSION, type TableRead } from "./table.js";

/** The `shape-v1.yml` this package ships, with `needsOwns` on the size rows. */
export const DEFAULT_WORKFLOW_TABLE = fileURLToPath(new URL(`../../workflow/${TABLE_VERSION}.yml`, import.meta.url));

export const workflowTablePath = (autonomyRoot: string): string =>
  path.join(autonomyRoot, "workflow", `${TABLE_VERSION}.yml`);

/** `<autonomyRoot>/workflow/shape-v1.yml`, linted; undefined when the file is absent. */
export function readWorkflowTable(autonomyRoot: string): TableRead | undefined {
  const file = workflowTablePath(autonomyRoot);
  if (!fs.existsSync(file)) return undefined;
  return parseWorkflowTable(fs.readFileSync(file, "utf8"));
}

/** The router for `mode`, or the one note saying why the dispatch routes as today; `off` touches no file. */
export function readPriorRouter(mode: PriorRouting, autonomyRoot: string): { router?: PriorRouter; note?: string } {
  if (mode === "off") return {};
  const read = readWorkflowTable(autonomyRoot);
  if (read === undefined)
    return { note: `prior routing ${mode}: no workflow table at ${workflowTablePath(autonomyRoot)}; routing as today` };
  if (read.table === undefined)
    return { note: `prior routing ${mode}: workflow table: ${read.problems.join("; ")}; routing as today` };
  return { router: { mode, table: read.table } };
}

export type RouteTableRead = { table: RouteTable; problem?: undefined } | { table?: undefined; problem: string };

const tableCache = new Map<string, { mtimeMs: number; size: number; read: RouteTableRead }>();

function parseRouteTable(bytes: Buffer): RouteTableRead {
  const read = parseWorkflowTable(bytes.toString("utf8"));
  if (read.table === undefined) return { problem: `workflow table: ${read.problems.join("; ")}` };
  const sha = createHash("sha256").update(bytes).digest("hex").slice(0, 8);
  return { table: { table: read.table, id: `${TABLE_VERSION}@${sha}` } };
}

/**
 * The table at `file` with its `shape-v1@<sha8>` id for the decision log. A spawn path calls this per spawn, so the
 * file is re-read and re-linted only when its mtime or size changes.
 */
export function readRouteTable(file: string): RouteTableRead {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    tableCache.delete(file);
    return { problem: `no workflow table at ${file}` };
  }
  const cached = tableCache.get(file);
  if (cached?.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.read;
  const read = parseRouteTable(fs.readFileSync(file));
  tableCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, read });
  return read;
}

export interface SpawnFacts {
  facts: TaskFacts;
  note: FactsNote;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

const readText = (file: string): string | undefined => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
};

/** The first initiative, in name order, holding `<slug>/tasks/<taskId>.yml`, and whether a second one does too. */
function findTask(root: string, taskId: string): { slug?: string; ambiguous: boolean } {
  if (!SAFE_ID.test(taskId)) return { ambiguous: false };
  let slugs: string[];
  try {
    slugs = fs.readdirSync(root).filter((slug) => !slug.startsWith(".")).sort();
  } catch {
    return { ambiguous: false };
  }
  const hits = slugs.filter((slug) => fs.existsSync(path.join(root, slug, "tasks", `${taskId}.yml`)));
  return { slug: hits[0], ambiguous: hits.length > 1 };
}

const taskSchema = z.object({
  estimate: z.number().nullish().catch(undefined),
  done_when: z.string().nullish().catch(undefined),
  tags: z.array(z.string()).nullish().catch(undefined),
  kind: z.string().nullish().catch(undefined),
});

/** Estimate, done_when and tags from a task file; a top-level `kind:` field is folded in as a `kind:<x>` tag. */
function taskFields(text: string | undefined): Omit<TaskFacts, "owns"> {
  let raw: unknown;
  try {
    raw = text === undefined ? undefined : parse(text);
  } catch {
    return {};
  }
  const parsed = taskSchema.safeParse(raw);
  if (!parsed.success) return {};
  const { estimate, done_when, tags, kind } = parsed.data;
  const kindTag = kind ? [`kind:${kind}`] : [];
  return { estimate, done_when, tags: [...new Set([...(tags ?? []), ...kindTag])] };
}

function ownsFrom(planText: string | undefined, slice: string | undefined, reqOwns: readonly string[]) {
  const plan = planFacts(planText, slice);
  if (plan.owns.length > 0) return { ...plan, source: slice === undefined ? "plan" : "plan-slice" } as const;
  if (reqOwns.length > 0) return { owns: [...reqOwns], source: "req" } as const;
  return { owns: [], source: "none" } as const;
}

function presentFacts(facts: TaskFacts, sliceRead: boolean): FactName[] {
  const present: [FactName, boolean][] = [
    ["estimate", typeof facts.estimate === "number"],
    ["done_when", Boolean(facts.done_when)],
    ["kind", (facts.tags ?? []).some((tag) => tag.startsWith("kind:"))],
    ["owns", facts.owns.length > 0],
    ["slice", sliceRead],
  ];
  return present.flatMap(([name, held]) => (held ? [name] : []));
}

/**
 * The facts a spawn routes on, read from the active-work root: estimate, done_when and tags from the task file, and
 * owns from `sources/<taskId>-plan.md`. With a slice, that slice's owns and points (as the estimate); without one,
 * the union of owns and the task estimate; with no plan owns, the spawn's own `reqOwns`.
 */
export function readSpawnFacts(
  root: string,
  taskId: string,
  slice?: string,
  reqOwns: readonly string[] = [],
): SpawnFacts {
  const { slug, ambiguous } = findTask(root, taskId);
  const taskDir = slug === undefined ? undefined : path.join(root, slug);
  const task = taskFields(taskDir === undefined ? undefined : readText(path.join(taskDir, "tasks", `${taskId}.yml`)));
  const plan = taskDir === undefined ? undefined : readText(path.join(taskDir, "sources", `${taskId}-plan.md`));
  const owned = ownsFrom(plan, slice, reqOwns);
  const facts: TaskFacts = { ...task, owns: owned.owns };
  if ("points" in owned && owned.points !== undefined) facts.estimate = owned.points;
  const note: FactsNote = { source: owned.source, present: presentFacts(facts, owned.source === "plan-slice") };
  if (ambiguous) note.ambiguous = true;
  return { facts, note };
}
