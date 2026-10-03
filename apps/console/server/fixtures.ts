// Synthetic active-work answers for tests and screenshots. Nothing here is copied from a real workspace.
import type { ActiveWork } from "./active-work.js";

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
];

const SOURCES = [
  { id: "orbit-relay:sources:deepdive-routing-table.md", slug: "orbit-relay", filename: "deepdive-routing-table.md", path: "/synthetic/orbit-relay/sources/deepdive-routing-table.md", type: "deepdive", title: "Routing table format", nested: false, mtime: "2031-02-20T09:00:00.000Z" },
  { id: "orbit-relay:sources:pr-41-handshake.md", slug: "orbit-relay", filename: "pr-41-handshake.md", path: "/synthetic/orbit-relay/sources/pr-41-handshake.md", type: "pr", title: "Handshake rewrite", nested: false, mtime: "2031-02-25T17:10:00.000Z" },
  { id: "orbit-relay:sources:captures/station-7.md", slug: "orbit-relay", filename: "captures/station-7.md", path: "/synthetic/orbit-relay/sources/captures/station-7.md", type: "pointer", title: "Station 7 capture", nested: true, mtime: "2031-02-26T08:00:00.000Z" },
];

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
      return { notes: records ? NOTES : [], errors: [] };
    case "source.list":
      return { sources: records ? SOURCES.filter((source) => args.nested || !source.nested) : [], drift: [] };
    case "source.read":
      return { path: "brief.md", content: BRIEF, truncated: false, bytes: BRIEF.length };
    default:
      throw new Error(`The fixture has no answer for ${command}`);
  }
}

/** The fixture as an in-process source, for a test that needs no socket. */
export function fixtureActiveWork(options: FixtureOptions = {}): ActiveWork {
  return { read: async (command, args = {}) => fixtureAnswer(command, args, options) as never };
}
