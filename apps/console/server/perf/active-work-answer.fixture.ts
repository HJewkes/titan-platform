import { EXIT } from "@titan-design/registry";
import type { RpcAnswer } from "../test-support.js";
import type { ActiveWorkState, AwNote, AwSource } from "./active-work.fixture.js";
import { isoAt } from "./random.fixture.js";

type Args = Record<string, unknown>;

const SESSIONS_PER_INITIATIVE = 20;
const STATS_BYTES_PER_FILE = 1200;
const SECTION_HEADINGS = { focused: "Focused", backburner: "Backburner", paused: "Paused", done: "Done" } as const;

const forSlug = <T extends { slug: string }>(rows: readonly T[], args: Args): T[] => (args.all_initiatives ? [...rows] : rows.filter((row) => row.slug === args.slug));

const stat = (files: number, newest: string | null = null) => ({ files, bytes: files * STATS_BYTES_PER_FILE, newest_mtime: newest });

function list(state: ActiveWorkState) {
  const sections = Object.entries(SECTION_HEADINGS).map(([key, heading]) => ({
    heading,
    items: state.initiatives.filter((item) => item.state === key).map(({ prefix: _prefix, personal: _personal, ...item }) => item),
  }));
  return { sections, parse_errors: [] };
}

function inventory(state: ActiveWorkState) {
  const count = (rows: readonly { slug: string }[], slug: string): number => rows.filter((row) => row.slug === slug).length;
  const initiatives = state.initiatives.map(({ slug, personal, updated }) => {
    const tasks = count(state.tasks, slug);
    const notes = count(state.notes, slug);
    const sources = state.sources.filter((source) => source.slug === slug);
    const nested = sources.filter((source) => source.nested).length;
    const classes = { initiatives: stat(1), tasks: stat(tasks), sessions: stat(SESSIONS_PER_INITIATIVE), notes: stat(notes), sources: stat(sources.length - nested), nested_sources: stat(nested) };
    const files = 1 + tasks + SESSIONS_PER_INITIATIVE + notes + sources.length;
    return { slug, human_only: personal, total: stat(files, `${updated}T00:00:00.000Z`), classes, nested_dirs: [] };
  });
  return { initiatives, totals: {}, human_only_known: true };
}

function taskList(state: ActiveWorkState, args: Args) {
  const tasks = forSlug(state.tasks, args);
  return { tasks: args.status === "all" ? tasks : tasks.filter((task) => task.status === "open") };
}

function sessionList(args: Args) {
  const slug = String(args.slug);
  const sessions = Array.from({ length: SESSIONS_PER_INITIATIVE }, (_, index) => ({
    filename: `${isoAt(-index * 24).slice(0, 10)}-1000-${slug}-${index}.md`,
    frontmatter: { session_id: `${slug}-${index}`, started: isoAt(-index * 24), ended: isoAt(-index * 24 + 1), track: index % 3 === 0 ? "sidecar" : "canonical" },
    first_line: `# Session ${index} on ${slug}`,
  }));
  return { sessions: sessions.slice(0, typeof args.limit === "number" ? args.limit : sessions.length), errors: [] };
}

function loops(state: ActiveWorkState, args: Args) {
  const open = state.tasks
    .filter((task) => task.slug === args.slug && task.status === "open")
    .slice(0, 5)
    .map((task, index) => ({ ref: `${task.slug}-${index}#1`, text: `Finish ${task.id}`, kind: "task", target_ref: task.id, session_file: `${task.slug}-${index}.md`, opened_at: isoAt(-index * 24), age_days: index }));
  return { slug: args.slug, open, resolved: [] };
}

const noteRow = ({ path: _path, ...note }: AwNote) => note;
const sourceRow = ({ path: _path, nested: _nested, ...source }: AwSource) => source;

function notFound(what: string): Error {
  return Object.assign(new Error(`${what} not found`), { code: EXIT.NOINPUT });
}

function noteRead(state: ActiveWorkState, args: Args) {
  const note = state.notes.find((entry) => entry.slug === args.slug && `sources/notes/${entry.filename}` === args.note);
  if (!note) throw notFound(`note ${String(args.note)}`);
  const body = `## ${note.kind}\n\n${"Synthetic body text. ".repeat(40)}\n`;
  return { id: note.id, slug: note.slug, filename: note.filename, path: `sources/notes/${note.filename}`, kind: note.kind, title: note.title, created: note.created, body, truncated: false };
}

function sourceRead(state: ActiveWorkState, args: Args) {
  const initiative = state.initiatives.find((entry) => entry.slug === args.slug);
  const source = state.sources.find((entry) => entry.slug === args.slug && `sources/${entry.filename}` === args.path);
  if (args.path === "brief.md" && initiative) {
    const content = `---\ntitle: "${initiative.title}"\nstate: ${initiative.state}\ntask_prefix: ${initiative.prefix}\n---\n\n# ${initiative.title}\n\n${"Synthetic brief text. ".repeat(60)}\n`;
    return { path: args.path, content, truncated: false, bytes: content.length };
  }
  if (!source) throw notFound(`file ${String(args.path)}`);
  const content = `---\ntype: ${source.type}\n---\n\n# ${source.title}\n\n${"Synthetic source text. ".repeat(30)}\n`;
  return { path: args.path, content, truncated: false, bytes: content.length };
}

function search(state: ActiveWorkState, args: Args) {
  const query = String(args.query ?? "").toLowerCase();
  const limit = typeof args.limit === "number" ? args.limit : 50;
  const notes = state.notes.map((note) => ({ ref: `note:${note.slug}/${note.filename}`, class: "note", initiative: note.slug, title: note.title }));
  const sources = state.sources.map((source) => ({ ref: `source:${source.slug}/${source.filename}`, class: "source", initiative: source.slug, title: source.title }));
  const hits = [...notes, ...sources].filter((hit) => hit.title.toLowerCase().includes(query)).slice(0, limit);
  return { query: args.query, hits: hits.map((hit, rank) => ({ ...hit, path: null, excerpt: `…${hit.title}…`, score: 1 / (rank + 1), sources: ["fts"] })), degraded: [] };
}

/** Every task that names `id` as its parent or a dep refers to it, as active-work's context graph reports. */
function contextGraph(state: ActiveWorkState, args: Args) {
  const id = String(args.id);
  const references = state.tasks
    .filter((task) => task.parent === id || task.dep?.includes(id))
    .map((task) => ({ slug: task.slug, source: "task", file: `tasks/${task.id}.yml`, field: task.parent === id ? "parent" : "dep", text: id }));
  return { references };
}

/** Answers from memory, the whole-workspace reads built once, so a budget measures the console's own cost and never active-work's. */
export function activeWorkAnswer(state: ActiveWorkState): RpcAnswer {
  const whole = { list: list(state), inventory: inventory(state) };
  const answers: Record<string, (args: Args) => unknown> = {
    list: () => whole.list,
    inventory: () => whole.inventory,
    "task.list": (args) => taskList(state, args),
    "session.list": sessionList,
    loops: (args) => loops(state, args),
    "note.list": (args) => ({ notes: forSlug(state.notes, args).map(noteRow), errors: [] }),
    "note.read": (args) => noteRead(state, args),
    "source.list": (args) => ({ sources: forSlug(state.sources, args).filter((source) => args.nested || !source.nested).map(sourceRow), drift: [] }),
    "source.read": (args) => sourceRead(state, args),
    search: (args) => search(state, args),
    "artifact.list": (args) => ({ items: forSlug(state.artifacts, args) }),
    "artifact.status": () => ({ branches: [], worktrees: [] }),
    "context.graph": (args) => contextGraph(state, args),
    "deliverable.list": () => state.deliverables,
  };
  return (command, args) => {
    const answer = answers[command];
    if (!answer) throw new Error(`the perf fixture has no active-work answer for ${command}`);
    return answer(args);
  };
}
