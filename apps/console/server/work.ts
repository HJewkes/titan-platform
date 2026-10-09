import path from "node:path";
import { z } from "zod";
import { EXIT } from "@titan-design/registry";
import { failure, type ActiveWork, type ReadResult, type WireInitiative, type WireInventoryInitiative, type WireTask } from "./active-work.js";
import { readCommand } from "./owner-guard.js";

const SEVERITIES = ["critical", "high", "medium", "low"] as const;
const severity = z.enum(SEVERITIES);

const initiativeHead = z.object({
  slug: z.string(),
  title: z.string(),
  state: z.enum(["focused", "backburner", "paused", "done"]),
  rank: z.number().optional(),
  shipTarget: z.string().optional(),
  updated: z.string(),
  /** A human-only initiative. True also when active-work could not say, so an export never guesses. */
  personal: z.boolean(),
});

const portfolioRow = initiativeHead.extend({
  /** The brief's `task_prefix`, so a task id maps to its initiative; absent when the brief names none. */
  taskPrefix: z.string().optional(),
  openTasks: z.number(),
  severityCounts: z.object({ critical: z.number(), high: z.number(), medium: z.number(), low: z.number() }),
  topTask: z.object({ id: z.string(), title: z.string() }).optional(),
  notes: z.number(),
  /** Top-level and nested source files together. */
  sources: z.number(),
  sessions: z.number(),
  newestActivity: z.string().nullable(),
});

export const portfolioResult = z.object({
  fetchedAt: z.string(),
  /** False when active-work could not read which initiatives are human-only; every one is then personal. */
  personalKnown: z.boolean(),
  initiatives: z.array(portfolioRow),
  parseErrors: z.array(z.object({ slug: z.string(), error: z.string() })),
});

const taskRow = z.object({
  slug: z.string(),
  id: z.string(),
  title: z.string(),
  priority: z.number(),
  severity: severity.optional(),
  estimate: z.number().optional(),
  tags: z.array(z.string()).optional(),
  updated: z.string(),
});

export const initiativeResult = z.object({
  fetchedAt: z.string(),
  initiative: initiativeHead,
  brief: z.object({ body: z.string(), truncated: z.boolean() }),
  /** The highest-priority open tasks, capped so one large initiative cannot flood the page. */
  tasks: z.array(taskRow),
  /** Every open task, including the ones past the cap. */
  openTasks: z.number(),
  sessions: z.array(z.object({ filename: z.string(), started: z.string(), ended: z.string(), track: z.string(), title: z.string() })),
  loops: z.array(
    z.object({ ref: z.string(), kind: z.enum(["task", "pr", "prose"]), text: z.string(), targetRef: z.string().optional(), openedAt: z.string(), sessionFile: z.string() }),
  ),
  notes: z.array(z.object({ id: z.string(), filename: z.string(), kind: z.string(), title: z.string(), created: z.string(), mtime: z.string().nullable() })),
  /** Top-level sources only; an initiative can hold thousands of nested files. */
  sources: z.array(z.object({ id: z.string(), filename: z.string(), type: z.string(), title: z.string(), mtime: z.string().nullable() })),
  /** Files under `sources/<dir>/`, counted and not listed. */
  nestedSources: z.number(),
});

export type Portfolio = z.infer<typeof portfolioResult>;
export type InitiativeDetail = z.infer<typeof initiativeResult>;
type InitiativeHead = z.infer<typeof initiativeHead>;
type PortfolioRow = z.infer<typeof portfolioRow>;

export interface WorkOptions {
  /** Set by the export: a page that leaves this machine carries no personal initiative. */
  excludePersonal?: boolean;
  /** Open tasks sent for one initiative. Defaults to 200. */
  taskLimit?: number;
}

const SESSION_LIMIT = 20;
const TASK_LIMIT = 200;

/** The list fields only: notes and done_when stay out of a page that shows a table. */
export function taskRowOf(task: WireTask): z.infer<typeof taskRow> {
  const { slug, id, title, priority, severity, estimate, tags, updated } = task;
  return { slug, id, title, priority, ...(severity ? { severity } : {}), ...(estimate !== undefined ? { estimate } : {}), ...(tags ? { tags } : {}), updated };
}

/** Fails closed twice: when active-work could not say which initiatives are human-only, and when the inventory does not name this one. */
export function isPersonal(known: boolean, inventory: WireInventoryInitiative | undefined): boolean {
  return !known || (inventory?.human_only ?? true);
}

function headOf(item: WireInitiative, personal: boolean): InitiativeHead {
  return {
    slug: item.slug,
    title: item.title,
    state: item.state,
    ...(item.rank !== undefined ? { rank: item.rank } : {}),
    ...(item.ship_target !== undefined ? { shipTarget: item.ship_target } : {}),
    updated: item.updated,
    personal,
  };
}

function rowOf(item: WireInitiative, tasks: readonly WireTask[], inventory: WireInventoryInitiative | undefined, known: boolean, taskPrefix?: string): PortfolioRow {
  const count = (level: (typeof SEVERITIES)[number]): number => tasks.filter((task) => task.severity === level).length;
  const top = tasks[0];
  const classes = inventory?.classes;
  return {
    ...headOf(item, isPersonal(known, inventory)),
    ...(taskPrefix !== undefined ? { taskPrefix } : {}),
    openTasks: tasks.length,
    severityCounts: { critical: count("critical"), high: count("high"), medium: count("medium"), low: count("low") },
    ...(top ? { topTask: { id: top.id, title: top.title } } : {}),
    notes: classes?.notes.files ?? 0,
    sources: (classes?.sources.files ?? 0) + (classes?.nested_sources.files ?? 0),
    sessions: classes?.sessions.files ?? 0,
    newestActivity: inventory?.total.newest_mtime ?? null,
  };
}

/** Every initiative with its open-task rollup and record counts, in active-work's own state and rank order. */
export async function readPortfolio(activeWork: ActiveWork, options: WorkOptions = {}): Promise<Portfolio> {
  const [list, tasks, inventory] = await Promise.all([
    activeWork.read("list"),
    activeWork.read("task.list", { all_initiatives: true }),
    activeWork.read("inventory"),
  ]);
  const bySlug = new Map(inventory.initiatives.map((entry) => [entry.slug, entry]));
  const items = list.sections.flatMap((section) => section.items);
  const prefixes = await Promise.all(items.map((item) => taskPrefixOf(activeWork, item.slug)));
  const rows = items.map((item, index) =>
    rowOf(item, tasks.tasks.filter((task) => task.slug === item.slug), bySlug.get(item.slug), inventory.human_only_known, prefixes[index]),
  );
  const kept = options.excludePersonal ? rows.filter((row) => !row.personal) : rows;
  const keptSlugs = new Set(kept.map((row) => row.slug));
  return {
    fetchedAt: new Date().toISOString(),
    personalKnown: inventory.human_only_known,
    initiatives: kept,
    parseErrors: options.excludePersonal ? list.parse_errors.filter((entry) => keptSlugs.has(entry.slug)) : list.parse_errors,
  };
}

async function readHead(activeWork: ActiveWork, slug: string): Promise<{ initiative: InitiativeHead; nestedSources: number }> {
  const [list, inventory] = await Promise.all([activeWork.read("list"), activeWork.read("inventory")]);
  const item = list.sections.flatMap((section) => section.items).find((entry) => entry.slug === slug);
  if (!item) throw failure(`No initiative named "${slug}"`, EXIT.NOINPUT);
  const counted = inventory.initiatives.find((entry) => entry.slug === slug);
  return { initiative: headOf(item, isPersonal(inventory.human_only_known, counted)), nestedSources: counted?.classes.nested_sources.files ?? 0 };
}

const TASK_PREFIX = /^task_prefix:\s*["']?([A-Z][A-Z0-9]*)["']?\s*$/m;

/** active-work's `list` does not carry the prefix, so it comes from the brief's frontmatter; an unreadable brief has none. */
async function taskPrefixOf(activeWork: ActiveWork, slug: string): Promise<string | undefined> {
  const brief = await activeWork.read("source.read", { slug, path: "brief.md" }).catch(() => null);
  const frontmatter = brief ? /^---\r?\n([\s\S]*?)\r?\n---/.exec(brief.content)?.[1] : undefined;
  return frontmatter ? TASK_PREFIX.exec(frontmatter)?.[1] : undefined;
}

/** The body under the YAML frontmatter; the header already shows what the frontmatter holds. */
function briefBody(content: string): string {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

function sessionRows(sessions: ReadResult<"session.list">["sessions"]): InitiativeDetail["sessions"] {
  return sessions.map(({ filename, frontmatter, first_line }) => ({
    filename,
    started: frontmatter.started,
    ended: frontmatter.ended,
    track: frontmatter.track,
    title: first_line.replace(/^#+\s*/, "") || filename,
  }));
}

function loopRows(loops: ReadResult<"loops">["open"]): InitiativeDetail["loops"] {
  return loops.map((loop) => ({
    ref: loop.ref,
    kind: loop.kind,
    text: loop.text,
    ...(loop.target_ref !== undefined ? { targetRef: loop.target_ref } : {}),
    openedAt: loop.opened_at,
    sessionFile: loop.session_file,
  }));
}

/** One initiative's brief, open tasks, recent sessions, open loops, notes and sources. */
export async function readInitiative(activeWork: ActiveWork, slug: string, options: WorkOptions = {}): Promise<InitiativeDetail> {
  // The lookup comes first, so a slug active-work does not list never reaches a file read.
  const { initiative, nestedSources } = await readHead(activeWork, slug);
  if (options.excludePersonal && initiative.personal) throw failure(`"${slug}" is a personal initiative and is left out of exports`, EXIT.NOINPUT);
  const [brief, tasks, sessions, loops, notes, sources] = await Promise.all([
    activeWork.read("source.read", { slug, path: "brief.md" }),
    activeWork.read("task.list", { slug }),
    activeWork.read("session.list", { slug, limit: SESSION_LIMIT }),
    // Offline, so opening a page never makes active-work call GitHub.
    activeWork.read("loops", { slug, offline: true }),
    activeWork.read("note.list", { slug }),
    activeWork.read("source.list", { slug }),
  ]);
  return {
    fetchedAt: new Date().toISOString(),
    initiative,
    brief: { body: briefBody(brief.content), truncated: brief.truncated },
    // active-work answers in priority order, so the cap keeps the most urgent rows.
    tasks: tasks.tasks.slice(0, options.taskLimit ?? TASK_LIMIT).map(taskRowOf),
    openTasks: tasks.tasks.length,
    sessions: sessionRows(sessions.sessions),
    loops: loopRows(loops.open),
    notes: notes.notes,
    sources: sources.sources,
    nestedSources,
  };
}

const knowledgeKind = z.enum(["note", "source"]);

const knowledgeRow = z.object({
  /** `note:<slug>/<file>` or `source:<slug>/<path>`, the refs active-work's search and graph mint. */
  ref: z.string(),
  kind: knowledgeKind,
  slug: z.string(),
  /** Relative to `sources/notes/` for a note and to `sources/` for a source. */
  file: z.string(),
  title: z.string(),
  /** A note's kind or a source's type. */
  type: z.string(),
  /** A note whose file time is unknown falls back to its `created` date. */
  changed: z.string().nullable(),
});

const notesResult = z.object({ fetchedAt: z.string(), records: z.array(knowledgeRow) });

const recordResult = knowledgeRow.omit({ type: true, changed: true }).extend({
  fetchedAt: z.string(),
  /** A note's kind; a source has none. */
  type: z.string().nullable(),
  created: z.string().nullable(),
  body: z.string(),
  /** True when the file is longer than active-work's read cap and `body` is its head. */
  truncated: z.boolean(),
});

const searchResult = z.object({
  fetchedAt: z.string(),
  query: z.string(),
  hits: z.array(z.object({ ref: z.string(), class: z.string(), initiative: z.string().nullable(), title: z.string().nullable(), excerpt: z.string().nullable() })),
  /** Retrievers that failed; the search still answers with what the others found. */
  degraded: z.array(z.object({ retriever: z.string(), message: z.string() })),
});

type KnowledgeRow = z.infer<typeof knowledgeRow>;
type KnowledgeKind = z.infer<typeof knowledgeKind>;

const RECORD_REF = /^(note|source):([^/]+)\/(.+)$/;
const SEARCH_LIMIT = 50;

/** With personal initiatives excluded, a slug the inventory cannot vouch for, or a hit with no initiative, is dropped. */
async function keepsSlug(activeWork: ActiveWork, options: WorkOptions): Promise<(slug: string | null) => boolean> {
  if (!options.excludePersonal) return () => true;
  const inventory = await activeWork.read("inventory");
  const bySlug = new Map(inventory.initiatives.map((entry) => [entry.slug, entry]));
  return (slug) => slug !== null && !isPersonal(inventory.human_only_known, bySlug.get(slug));
}

function noteRow(note: ReadResult<"note.list">["notes"][number]): KnowledgeRow {
  return { ref: `note:${note.slug}/${note.filename}`, kind: "note", slug: note.slug, file: note.filename, title: note.title, type: note.kind, changed: note.mtime ?? note.created };
}

function sourceRow(source: ReadResult<"source.list">["sources"][number]): KnowledgeRow {
  return { ref: `source:${source.slug}/${source.filename}`, kind: "source", slug: source.slug, file: source.filename, title: source.title, type: source.type, changed: source.mtime };
}

const newestFirst = (a: KnowledgeRow, b: KnowledgeRow): number => (b.changed ?? "").localeCompare(a.changed ?? "") || a.ref.localeCompare(b.ref);

/** Notes and top-level sources across every initiative, newest change first. Nested source files are left out, as on the initiative page. */
export async function readNotes(activeWork: ActiveWork, options: WorkOptions = {}): Promise<z.infer<typeof notesResult>> {
  const [notes, sources, keeps] = await Promise.all([
    activeWork.read("note.list", { all_initiatives: true }),
    activeWork.read("source.list", { all_initiatives: true }),
    keepsSlug(activeWork, options),
  ]);
  const records = [...notes.notes.map(noteRow), ...sources.sources.map(sourceRow)];
  return { fetchedAt: new Date().toISOString(), records: records.filter((row) => keeps(row.slug)).sort(newestFirst) };
}

/** A `..` segment would step out of the notes or sources directory into the rest of the initiative. */
function parseRecordRef(ref: string): { kind: KnowledgeKind; slug: string; file: string } {
  const [, kind, slug, file] = RECORD_REF.exec(ref) ?? [];
  if (!kind || !slug || !file || file.split("/").includes("..")) throw failure(`Not a note or source ref: ${ref}`, EXIT.DATAERR);
  return { kind: kind as KnowledgeKind, slug, file };
}

const firstHeading = (body: string): string | undefined => /^#\s+(.+?)\s*$/m.exec(body)?.[1];

/** One note or source by its ref. A personal one is refused before any file read when personal initiatives are excluded. */
export async function readRecord(activeWork: ActiveWork, ref: string, options: WorkOptions = {}): Promise<z.infer<typeof recordResult>> {
  const { kind, slug, file } = parseRecordRef(ref);
  const keeps = await keepsSlug(activeWork, options);
  if (!keeps(slug)) throw failure(`No record ${ref}`, EXIT.NOINPUT);
  const head = { fetchedAt: new Date().toISOString(), ref, kind, slug, file };
  if (kind === "note") {
    const note = await activeWork.read("note.read", { slug, note: `sources/notes/${file}` });
    return { ...head, title: note.title, type: note.kind, created: note.created, body: note.body, truncated: note.truncated };
  }
  const source = await activeWork.read("source.read", { slug, path: `sources/${file}` });
  const body = briefBody(source.content).trimStart();
  return { ...head, title: firstHeading(body) ?? path.posix.basename(file), type: null, created: null, body, truncated: source.truncated };
}

/** active-work's search across every initiative, keyed by ref. */
export async function searchRecords(activeWork: ActiveWork, query: string, options: WorkOptions = {}): Promise<z.infer<typeof searchResult>> {
  const [answer, keeps] = await Promise.all([activeWork.read("search", { query, limit: SEARCH_LIMIT }), keepsSlug(activeWork, options)]);
  return {
    fetchedAt: new Date().toISOString(),
    query: answer.query,
    hits: answer.hits.filter((hit) => keeps(hit.initiative)),
    degraded: answer.degraded,
  };
}

/** The knowledge page's reads: every note and source, one record by ref, and search. */
export function knowledgeCommands(activeWork: ActiveWork, options: WorkOptions = {}) {
  return {
    "work.notes": readCommand({
      name: "work.notes",
      description: "Notes and top-level sources across every initiative, each with its note:<slug>/<file> or source:<slug>/<path> ref",
      args: z.object({}),
      result: notesResult,
      run: () => readNotes(activeWork, options),
    }),
    "work.record": readCommand({
      name: "work.record",
      description: "One note or source by its ref, with its markdown body, flagged when active-work's read cap truncated it",
      args: z.object({ ref: z.string().regex(RECORD_REF) }),
      result: recordResult,
      run: ({ ref }) => readRecord(activeWork, ref, options),
    }),
    "work.search": readCommand({
      name: "work.search",
      description: "active-work's search across every initiative: notes, briefs, sources, tasks and session records, as hits by ref",
      args: z.object({ q: z.string().min(1) }),
      result: searchResult,
      run: ({ q }) => searchRecords(activeWork, q, options),
    }),
  };
}
