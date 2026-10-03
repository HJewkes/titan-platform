import { z } from "zod";
import { EXIT } from "@titan-design/registry";
import { failure, type ActiveWork, type ReadResult, type WireInitiative, type WireInventoryInitiative, type WireTask } from "./active-work.js";

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
  tasks: z.array(taskRow),
  sessions: z.array(z.object({ filename: z.string(), started: z.string(), ended: z.string(), track: z.string(), title: z.string() })),
  loops: z.array(
    z.object({ ref: z.string(), kind: z.enum(["task", "pr", "prose"]), text: z.string(), targetRef: z.string().optional(), openedAt: z.string(), sessionFile: z.string() }),
  ),
  notes: z.array(z.object({ id: z.string(), filename: z.string(), kind: z.string(), title: z.string(), created: z.string(), mtime: z.string().nullable() })),
  sources: z.array(z.object({ id: z.string(), filename: z.string(), type: z.string(), title: z.string(), nested: z.boolean(), mtime: z.string().nullable() })),
});

export type Portfolio = z.infer<typeof portfolioResult>;
export type InitiativeDetail = z.infer<typeof initiativeResult>;
type InitiativeHead = z.infer<typeof initiativeHead>;
type PortfolioRow = z.infer<typeof portfolioRow>;

export interface WorkOptions {
  /** Set by the export: a page that leaves this machine carries no personal initiative. */
  excludePersonal?: boolean;
}

const SESSION_LIMIT = 20;

function headOf(item: WireInitiative, inventory: WireInventoryInitiative | undefined): InitiativeHead {
  return {
    slug: item.slug,
    title: item.title,
    state: item.state,
    ...(item.rank !== undefined ? { rank: item.rank } : {}),
    ...(item.ship_target !== undefined ? { shipTarget: item.ship_target } : {}),
    updated: item.updated,
    // Fails closed: an initiative the inventory does not name is treated as personal.
    personal: inventory?.human_only ?? true,
  };
}

function rowOf(item: WireInitiative, tasks: readonly WireTask[], inventory: WireInventoryInitiative | undefined): PortfolioRow {
  const count = (level: (typeof SEVERITIES)[number]): number => tasks.filter((task) => task.severity === level).length;
  const top = tasks[0];
  const classes = inventory?.classes;
  return {
    ...headOf(item, inventory),
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
  const rows = list.sections
    .flatMap((section) => section.items)
    .map((item) => rowOf(item, tasks.tasks.filter((task) => task.slug === item.slug), bySlug.get(item.slug)));
  const kept = options.excludePersonal ? rows.filter((row) => !row.personal) : rows;
  const keptSlugs = new Set(kept.map((row) => row.slug));
  return {
    fetchedAt: new Date().toISOString(),
    personalKnown: inventory.human_only_known,
    initiatives: kept,
    parseErrors: options.excludePersonal ? list.parse_errors.filter((entry) => keptSlugs.has(entry.slug)) : list.parse_errors,
  };
}

async function readHead(activeWork: ActiveWork, slug: string): Promise<InitiativeHead> {
  const [list, inventory] = await Promise.all([activeWork.read("list"), activeWork.read("inventory")]);
  const item = list.sections.flatMap((section) => section.items).find((entry) => entry.slug === slug);
  if (!item) throw failure(`No initiative named "${slug}"`, EXIT.NOINPUT);
  return headOf(item, inventory.initiatives.find((entry) => entry.slug === slug));
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
  const initiative = await readHead(activeWork, slug);
  if (options.excludePersonal && initiative.personal) throw failure(`"${slug}" is a personal initiative and is left out of exports`, EXIT.NOINPUT);
  const [brief, tasks, sessions, loops, notes, sources] = await Promise.all([
    activeWork.read("source.read", { slug, path: "brief.md" }),
    activeWork.read("task.list", { slug }),
    activeWork.read("session.list", { slug, limit: SESSION_LIMIT }),
    // Offline, so opening a page never makes active-work call GitHub.
    activeWork.read("loops", { slug, offline: true }),
    activeWork.read("note.list", { slug }),
    activeWork.read("source.list", { slug, nested: true }),
  ]);
  return {
    fetchedAt: new Date().toISOString(),
    initiative,
    brief: { body: briefBody(brief.content), truncated: brief.truncated },
    tasks: tasks.tasks,
    sessions: sessionRows(sessions.sessions),
    loops: loopRows(loops.open),
    notes: notes.notes,
    sources: sources.sources,
  };
}
