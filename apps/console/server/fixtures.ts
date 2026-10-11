// Synthetic active-work answers for tests and screenshots. Nothing here is copied from a real workspace.
import { EXIT } from "@titan-design/registry";
import { failure, type ActiveWork } from "./active-work.js";

type Args = Record<string, unknown>;

const stat = (files: number, newest: string | null = null) => ({ files, bytes: files * 1200, newest_mtime: newest });

const INITIATIVES = [
  { slug: "orbit-relay", title: "Orbit relay: message routing between stations", state: "focused", rank: 1, ship_target: "2031-Q2", updated: "2031-03-04" },
  { slug: "lantern-docs", title: "Lantern docs: one handbook for the field kit", state: "focused", rank: 2, updated: "2031-03-01" },
  { slug: "kiln-tools", title: "Kiln tools: firing schedule calculator", state: "backburner", updated: "2031-02-11" },
  { slug: "garden-plan", title: "Garden plan: spring beds", state: "paused", paused_since: "2031-01-20", updated: "2031-01-20" },
  { slug: "atlas-archive", title: "Atlas archive: scanned map index", state: "done", updated: "2030-12-02" },
];

/** `garden-plan` is the one personal initiative. */
const PERSONAL = new Set(["garden-plan"]);

const TASKS = [
  { slug: "orbit-relay", id: "OR-12", title: "Retry a dropped handshake with backoff", priority: 1, severity: "critical", estimate: 2, tags: ["transport"], updated: "2031-03-04" },
  { slug: "orbit-relay", id: "OR-14", title: "Report queue depth per station", priority: 2, severity: "high", estimate: 1, updated: "2031-03-02" },
  { slug: "orbit-relay", id: "OR-9", title: "Document the routing table format", priority: 3, severity: "low", updated: "2031-02-20" },
  { slug: "lantern-docs", id: "LD-3", title: "Merge the two battery chapters", priority: 1, severity: "medium", estimate: 3, updated: "2031-03-01" },
  { slug: "garden-plan", id: "GP-2", title: "Order seed trays", priority: 1, severity: "low", updated: "2031-01-18" },
].map((task) => ({ ...task, status: "open", created: "2031-01-05", done_at: null }));

const COUNTS: Record<string, { sessions: number; notes: number; sources: number; nested: number; newest: string }> = {
  "orbit-relay": { sessions: 2, notes: 2, sources: 2, nested: 1, newest: "2031-03-04T16:20:00.000Z" },
  "lantern-docs": { sessions: 1, notes: 1, sources: 1, nested: 0, newest: "2031-03-01T09:05:00.000Z" },
  "kiln-tools": { sessions: 0, notes: 0, sources: 1, nested: 0, newest: "2031-02-11T12:00:00.000Z" },
  "garden-plan": { sessions: 1, notes: 1, sources: 0, nested: 0, newest: "2031-01-20T08:00:00.000Z" },
  "atlas-archive": { sessions: 4, notes: 3, sources: 6, nested: 12, newest: "2030-12-02T18:45:00.000Z" },
};

const BRIEF = `---
title: "Orbit relay: message routing between stations"
state: focused
task_prefix: OR
---

# Orbit relay

## Why this exists

Stations drop messages when a relay restarts. This initiative makes the route durable.

## Current state

OR-12 is the next slice. The routing table format is settled; see [[routing-table]].

## Next

- Land the handshake retry.
- Measure queue depth before tuning the backoff.
`;

/** `atlas-archive` predates task prefixes, so its brief names none. */
const PREFIXES: Record<string, string> = { "lantern-docs": "LD", "kiln-tools": "KT", "garden-plan": "GP" };

function brief(slug: unknown): string {
  if (slug === "orbit-relay") return BRIEF;
  const prefix = typeof slug === "string" ? PREFIXES[slug] : undefined;
  return `---\nstate: focused\n${prefix ? `task_prefix: "${prefix}"\n` : ""}---\n\n# ${String(slug)}\n`;
}

const SESSIONS = [
  { filename: "2031-03-04-1500-relay-retry.md", frontmatter: { session_id: "relay-retry", started: "2031-03-04T15:00:00Z", ended: "2031-03-04T16:20:00Z", track: "canonical" }, first_line: "# Handshake retry spike" },
  { filename: "2031-03-02-1000-queue-depth.md", frontmatter: { session_id: "queue-depth", started: "2031-03-02T10:00:00Z", ended: "2031-03-02T10:42:00Z", track: "sidecar" }, first_line: "# Queue depth probe" },
];

const LOOPS = [
  { ref: "2031-03-04-1500-relay-retry#1", text: "Finish OR-12 once the backoff numbers are in", kind: "task", target_ref: "OR-12", session_file: "2031-03-04-1500-relay-retry.md", opened_at: "2031-03-04T16:20:00Z", age_days: 0 },
];

const NOTES = [
  { id: "orbit-relay:notes:2031-03-03-backoff-ceiling.md", slug: "orbit-relay", filename: "2031-03-03-backoff-ceiling.md", path: "/synthetic/orbit-relay/sources/notes/2031-03-03-backoff-ceiling.md", kind: "decision", title: "Cap the backoff at thirty seconds", created: "2031-03-03", mtime: "2031-03-03T11:00:00.000Z" },
  { id: "orbit-relay:notes:2031-02-27-station-clock-skew.md", slug: "orbit-relay", filename: "2031-02-27-station-clock-skew.md", path: "/synthetic/orbit-relay/sources/notes/2031-02-27-station-clock-skew.md", kind: "gotcha", title: "Station clocks drift by minutes", created: "2031-02-27", mtime: "2031-02-27T14:30:00.000Z" },
  { id: "lantern-docs:notes:2031-02-28-chapter-order.md", slug: "lantern-docs", filename: "2031-02-28-chapter-order.md", path: "/synthetic/lantern-docs/sources/notes/2031-02-28-chapter-order.md", kind: "plan", title: "Battery chapters come before radios", created: "2031-02-28", mtime: null },
  { id: "garden-plan:notes:2031-01-19-seed-list.md", slug: "garden-plan", filename: "2031-01-19-seed-list.md", path: "/synthetic/garden-plan/sources/notes/2031-01-19-seed-list.md", kind: "fyi", title: "Seed list for the spring beds", created: "2031-01-19", mtime: "2031-01-19T10:00:00.000Z" },
];

const NOTE_BODY = `## Decision

Retries back off exponentially and **stop growing at thirty seconds**.

- A station that restarts is back within a minute.
- See OR-12 for the retry itself.
`;

const SOURCES = [
  { id: "orbit-relay:sources:deepdive-routing-table.md", slug: "orbit-relay", filename: "deepdive-routing-table.md", path: "/synthetic/orbit-relay/sources/deepdive-routing-table.md", type: "deepdive", title: "Routing table format", nested: false, mtime: "2031-02-20T09:00:00.000Z" },
  { id: "orbit-relay:sources:pr-41-handshake.md", slug: "orbit-relay", filename: "pr-41-handshake.md", path: "/synthetic/orbit-relay/sources/pr-41-handshake.md", type: "pr", title: "Handshake rewrite", nested: false, mtime: "2031-02-25T17:10:00.000Z" },
  { id: "orbit-relay:sources:captures/station-7.md", slug: "orbit-relay", filename: "captures/station-7.md", path: "/synthetic/orbit-relay/sources/captures/station-7.md", type: "pointer", title: "Station 7 capture", nested: true, mtime: "2031-02-26T08:00:00.000Z" },
  { id: "kiln-tools:sources:deepdive-cone-chart.md", slug: "kiln-tools", filename: "deepdive-cone-chart.md", path: "/synthetic/kiln-tools/sources/deepdive-cone-chart.md", type: "deepdive", title: "Cone chart", nested: false, mtime: "2031-02-11T12:00:00.000Z" },
];

const notFound = (what: string): Error => failure(`${what} not found`, EXIT.NOINPUT);

function readNote(args: Args) {
  const note = NOTES.find((entry) => entry.slug === args.slug && `sources/notes/${entry.filename}` === args.note);
  if (!note) throw notFound(`note ${String(args.note)}`);
  const { slug, filename, kind, title, created } = note;
  return { id: note.id, slug, filename, path: `sources/notes/${filename}`, kind, title, created, body: NOTE_BODY, truncated: false };
}

function readSource(args: Args) {
  const content = args.path === "brief.md" ? brief(args.slug) : sourceContent(args);
  return { path: args.path, content, truncated: false, bytes: content.length };
}

function sourceContent(args: Args): string {
  const source = SOURCES.find((entry) => entry.slug === args.slug && `sources/${entry.filename}` === args.path);
  if (!source) throw notFound(`file ${String(args.path)}`);
  return `---\ntype: ${source.type}\n---\n\n# ${source.title}\n\nSynthetic text for ${source.filename}.\n`;
}

/** Matches titles only; the real search also ranks body text, briefs, tasks and transcripts. */
function search(args: Args) {
  const query = String(args.query).toLowerCase();
  const notes = NOTES.map((note) => ({ ref: `note:${note.slug}/${note.filename}`, class: "note", initiative: note.slug, title: note.title }));
  const sources = SOURCES.map((source) => ({ ref: `source:${source.slug}/${source.filename}`, class: "source", initiative: source.slug, title: source.title }));
  const hits = [...notes, ...sources].filter((hit) => hit.title.toLowerCase().includes(query));
  return { query: args.query, hits: hits.map((hit, rank) => ({ ...hit, path: null, excerpt: `…${hit.title}…`, score: 1 / (rank + 1), sources: ["fts"] })), degraded: [] };
}

function inventory(humanOnlyKnown: boolean) {
  const initiatives = INITIATIVES.map(({ slug }) => {
    const counts = COUNTS[slug]!;
    const tasks = TASKS.filter((task) => task.slug === slug).length;
    const classes = { initiatives: stat(1), tasks: stat(tasks), sessions: stat(counts.sessions), notes: stat(counts.notes), sources: stat(counts.sources), nested_sources: stat(counts.nested) };
    const files = 1 + tasks + counts.sessions + counts.notes + counts.sources + counts.nested;
    return { slug, human_only: !humanOnlyKnown || PERSONAL.has(slug), total: stat(files, counts.newest), classes, nested_dirs: [] };
  });
  return { initiatives, totals: {}, human_only_known: humanOnlyKnown };
}

function list() {
  const headings = { focused: "Focused", backburner: "Backburner", paused: "Paused", done: "Done" };
  const sections = Object.entries(headings).map(([state, heading]) => ({ heading, items: INITIATIVES.filter((item) => item.state === state) }));
  return { sections, parse_errors: [] };
}

const forSlug = <T extends { slug: string }>(rows: T[], args: Args): T[] => (args.all_initiatives ? rows : rows.filter((row) => row.slug === args.slug));

export interface FixtureOptions {
  /** False imitates an unreadable charter: active-work then flags every initiative human-only. */
  humanOnlyKnown?: boolean;
}

/** What the synthetic active-work daemon answers for one read; only `orbit-relay` has records behind its lists. */
export function fixtureAnswer(command: string, args: Args, options: FixtureOptions = {}): unknown {
  const records = args.slug === "orbit-relay";
  switch (command) {
    case "list":
      return list();
    case "inventory":
      return inventory(options.humanOnlyKnown ?? true);
    case "task.list":
      return { tasks: forSlug(TASKS, args) };
    case "session.list":
      return { sessions: records ? SESSIONS : [], errors: [] };
    case "loops":
      return { slug: args.slug, open: records ? LOOPS : [], resolved: [] };
    case "note.list":
      return { notes: forSlug(NOTES, args), errors: [] };
    case "note.read":
      return readNote(args);
    case "source.list":
      return { sources: forSlug(SOURCES, args).filter((source) => args.nested || !source.nested), drift: [] };
    case "source.read":
      return readSource(args);
    case "search":
      return search(args);
    default:
      throw new Error(`The fixture has no answer for ${command}`);
  }
}

/** The fixture as an in-process source, for a test that needs no socket. */
export function fixtureActiveWork(options: FixtureOptions = {}): ActiveWork {
  return { read: async (command, args = {}) => fixtureAnswer(command, args, options) as never };
}
