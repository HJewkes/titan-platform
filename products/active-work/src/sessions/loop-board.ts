/**
 * The platform-wide loop board (TP-4316): ledger rows, the session loops no
 * ledger row claims, and the tech tree, in the shape the console's #/loops and
 * #/tree pages read.
 *
 * `buildBoard` is pure. A malformed row is skipped and named in `warnings`,
 * never thrown, so one bad hand-copied row cannot blank both pages.
 */
import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import { listInitiativeSlugs } from '../commands/_open-helpers.js';
import { loadTasks } from '../lint/load-tasks.js';
import {
  LOOP_STATUSES,
  LedgerLoopSchema,
  TIERS,
  TreeGoalsSchema,
  TreeNodeSchema,
  type LedgerLoop,
  type LedgerTreeNode,
} from '../schemas/loop-ledger.js';
import { deriveOpenLoopsFrom, loadSessionsFromDir, type OpenLoop } from './open-loops.js';
import { readOptionalFile, type LedgerPaths } from './ledger-file.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export const LoopSourceSchema = z.enum(['ledger', 'session', 'handoff', 'teleport']);

const BoardLoopSchema = z.object({
  id: z.string(),
  title: z.string(),
  initiative: z.string(),
  status: z.enum(LOOP_STATUSES),
  tier: z.enum(TIERS).nullable(),
  tierRank: z.number().nullable(),
  tierSetBy: z.enum(['proposal', 'owner']).nullable(),
  ownerSeat: z.string().nullable(),
  doneWhen: z.string().nullable(),
  lastMotion: z.object({ date: z.string(), ref: z.string() }).nullable(),
  daysSinceMotion: z.number().nullable(),
  emphasis: z
    .object({ score: z.number(), distinctDays: z.number(), lastRaised: z.string().nullable() })
    .nullable(),
  tasks: z.object({ ids: z.array(z.string()), open: z.number(), done: z.number() }),
  prsOpen: z.array(z.string()),
  blockers: z.object({ ownerGated: z.array(z.string()), other: z.array(z.string()) }),
  treeNode: z.string().nullable(),
  source: LoopSourceSchema,
  sessionRef: z.string().nullable(),
});
type BoardLoop = z.infer<typeof BoardLoopSchema>;

const BoardTreeNodeSchema = z.object({
  id: z.string(),
  title: z.string(),
  goal: z.string(),
  dependsOn: z.array(z.string()),
  state: z.enum(['done', 'in progress', 'not started']),
  doneWhen: z.string(),
  loops: z.array(z.string()),
  churn: z.object({
    closed14d: z.number(),
    openNow: z.number(),
    doneWhenMoved: z.enum(['yes', 'partly', 'no']),
    highChurnNoProgress: z.boolean(),
  }),
});
type BoardTreeNode = z.infer<typeof BoardTreeNodeSchema>;

export const LoopBoardSchema = z.object({
  ledger: z.object({ path: z.string(), mtime: z.string().nullable() }).nullable(),
  loops: z.array(BoardLoopSchema),
  tree: z
    .object({
      goals: z.array(z.object({ id: z.string(), title: z.string() })),
      nodes: z.array(BoardTreeNodeSchema),
    })
    .nullable(),
  warnings: z.array(z.string()),
});
export type LoopBoard = z.infer<typeof LoopBoardSchema>;

interface SessionLoopSet {
  initiative: string;
  loops: OpenLoop[];
  /** Task id -> done, for the initiative's own tasks. */
  taskDone: Map<string, boolean>;
}

export interface BoardInput {
  ledger: { path: string; mtime: string | null; rows: unknown[] } | null;
  tree: { goals: unknown; nodes: unknown[] } | null;
  sessions: SessionLoopSet[];
  now: Date;
}

function daysSince(date: string, now: Date): number | null {
  const ms = new Date(date).getTime();
  return Number.isNaN(ms) ? null : Math.max(0, Math.floor((now.getTime() - ms) / MS_PER_DAY));
}

function seatOf(seat: string | null | undefined): string | null {
  return seat === undefined || seat === null || seat === '' || seat === 'none' ? null : seat;
}

function emphasisOf(row: LedgerLoop): BoardLoop['emphasis'] {
  const e = row.owner_emphasis;
  if (e === undefined || e === null) return null;
  return { score: e.score, distinctDays: e.distinct_days, lastRaised: e.last_raised ?? null };
}

function ledgerLoop(row: LedgerLoop, now: Date): BoardLoop {
  const motion = row.last_motion ?? null;
  return {
    id: row.id,
    title: row.title,
    initiative: row.initiative,
    status: row.status,
    tier: row.tier ?? null,
    tierRank: row.tier_rank ?? null,
    tierSetBy: row.tier_set?.by ?? null,
    ownerSeat: seatOf(row.owning_seat),
    doneWhen: row.done_when ?? null,
    lastMotion: motion,
    daysSinceMotion: motion === null ? null : daysSince(motion.date, now),
    emphasis: emphasisOf(row),
    tasks: row.linked_tasks ?? { ids: [], open: 0, done: 0 },
    prsOpen: row.linked_prs_open ?? [],
    blockers: {
      ownerGated: row.blockers?.owner_gated ?? [],
      other: row.blockers?.other ?? [],
    },
    treeNode: row.tech_tree_node ?? null,
    source: 'ledger',
    sessionRef: null,
  };
}

function issueText(error: z.ZodError): string {
  const issue = error.issues[0];
  return `${issue.path.join('.') || '(row)'}: ${issue.message}`;
}

function rowLabel(row: unknown, index: number): string {
  const id = typeof row === 'object' && row !== null && 'id' in row ? row.id : undefined;
  return typeof id === 'string' && id.length > 0 ? `ledger row ${id}` : `ledger row ${index + 1}`;
}

function parseLedgerRows(rows: unknown[], warnings: string[]): LedgerLoop[] {
  return rows.flatMap((row, index) => {
    const parsed = LedgerLoopSchema.safeParse(row);
    if (parsed.success) return [parsed.data];
    warnings.push(`Skipped ${rowLabel(row, index)}: ${issueText(parsed.error)}`);
    return [];
  });
}

function sessionTasks(loop: OpenLoop, taskDone: Map<string, boolean>): BoardLoop['tasks'] {
  if (loop.kind !== 'task' || loop.targetRef === undefined) return { ids: [], open: 0, done: 0 };
  const done = taskDone.get(loop.targetRef) === true;
  return { ids: [loop.targetRef], open: done ? 0 : 1, done: done ? 1 : 0 };
}

function sessionLoop(loop: OpenLoop, set: SessionLoopSet): BoardLoop {
  return {
    id: loop.ref,
    title: loop.text,
    initiative: set.initiative,
    status: 'ACTIVE',
    tier: null,
    tierRank: null,
    tierSetBy: null,
    ownerSeat: null,
    doneWhen: null,
    lastMotion: { date: loop.openedAt, ref: loop.ref },
    daysSinceMotion: loop.ageDays,
    emphasis: null,
    tasks: sessionTasks(loop, set.taskDone),
    prsOpen: [],
    blockers: { ownerGated: [], other: [] },
    treeNode: null,
    source: 'session',
    sessionRef: loop.ref,
  };
}

/** A ledger row claims a session loop when it links the loop's task. */
function unclaimedSessionLoops(sessions: SessionLoopSet[], ledger: LedgerLoop[]): BoardLoop[] {
  const claimed = new Set(ledger.flatMap((row) => row.linked_tasks?.ids ?? []));
  return sessions.flatMap((set) =>
    set.loops
      .filter((loop) => loop.targetRef === undefined || !claimed.has(loop.targetRef))
      .map((loop) => sessionLoop(loop, set)),
  );
}

function goalsOf(raw: unknown, warnings: string[]): Array<{ id: string; title: string }> {
  const parsed = TreeGoalsSchema.safeParse(raw ?? {});
  if (parsed.success) return Object.entries(parsed.data).map(([id, title]) => ({ id, title }));
  warnings.push(`Skipped the tree's goals: ${issueText(parsed.error)}`);
  return [];
}

function treeNode(node: LedgerTreeNode, loops: BoardLoop[]): BoardTreeNode {
  const linked = loops.filter((loop) => loop.treeNode === node.id).map((loop) => loop.id);
  return {
    id: node.id,
    title: node.title,
    goal: node.goal,
    dependsOn: node.depends_on,
    state: node.state,
    doneWhen: node.done_when,
    loops: [...new Set([...node.loops, ...linked])],
    churn: {
      closed14d: node.churn.closed_14d,
      openNow: node.churn.open_now,
      doneWhenMoved: node.churn.done_when_moved,
      highChurnNoProgress: node.churn.high_churn_no_progress,
    },
  };
}

function buildTree(tree: BoardInput['tree'], loops: BoardLoop[], warnings: string[]): LoopBoard['tree'] {
  if (tree === null) return null;
  const nodes = tree.nodes.flatMap((raw, index) => {
    const parsed = TreeNodeSchema.safeParse(raw);
    if (parsed.success) return [treeNode(parsed.data, loops)];
    warnings.push(`Skipped tree node ${index + 1}: ${issueText(parsed.error)}`);
    return [];
  });
  return { goals: goalsOf(tree.goals, warnings), nodes };
}

export function buildBoard(input: BoardInput): LoopBoard {
  const warnings: string[] = [];
  const rows = input.ledger === null ? [] : parseLedgerRows(input.ledger.rows, warnings);
  const loops = [
    ...rows.map((row) => ledgerLoop(row, input.now)),
    ...unclaimedSessionLoops(input.sessions, rows),
  ];
  return {
    ledger: input.ledger === null ? null : { path: input.ledger.path, mtime: input.ledger.mtime },
    loops,
    tree: buildTree(input.tree, loops, warnings),
    warnings,
  };
}

// ---------------------------------------------------------------------------
// loaders
// ---------------------------------------------------------------------------

function parseOrWarn(text: string, label: string, warnings: string[]): unknown {
  try {
    return YAML.parse(text) as unknown;
  } catch (err) {
    warnings.push(`Could not parse ${label}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

const LedgerFileSchema = z.looseObject({ loops: z.array(z.unknown()) });
const TreeFileSchema = z.looseObject({ goals: z.unknown(), nodes: z.array(z.unknown()) });

async function loadLedger(paths: LedgerPaths, warnings: string[]): Promise<BoardInput['ledger']> {
  const file = await readOptionalFile(paths.loopsPath);
  if (file === null) return null;
  const parsed = LedgerFileSchema.safeParse(parseOrWarn(file.text, paths.loopsPath, warnings));
  if (!parsed.success) warnings.push(`${paths.loopsPath} has no \`loops:\` list`);
  return { path: paths.loopsPath, mtime: file.mtime, rows: parsed.data?.loops ?? [] };
}

/** The ledger's valid rows, for callers that read it without the rest of the board. */
export async function readLedgerLoops(
  paths: LedgerPaths,
): Promise<{ rows: LedgerLoop[]; mtime: string | null; warnings: string[] }> {
  const warnings: string[] = [];
  const ledger = await loadLedger(paths, warnings);
  if (ledger === null) return { rows: [], mtime: null, warnings };
  return { rows: parseLedgerRows(ledger.rows, warnings), mtime: ledger.mtime, warnings };
}

async function loadTree(paths: LedgerPaths, warnings: string[]): Promise<BoardInput['tree']> {
  const file = await readOptionalFile(paths.treePath);
  if (file === null) return null;
  const parsed = TreeFileSchema.safeParse(parseOrWarn(file.text, paths.treePath, warnings));
  if (parsed.success) return { goals: parsed.data.goals, nodes: parsed.data.nodes };
  warnings.push(`${paths.treePath} has no \`nodes:\` list`);
  return null;
}

async function loadSessionSet(activeRoot: string, slug: string, now: Date): Promise<SessionLoopSet> {
  const dir = path.join(activeRoot, slug);
  const [loaded, tasks] = await Promise.all([loadSessionsFromDir(dir), loadTasks(dir)]);
  return {
    initiative: slug,
    loops: deriveOpenLoopsFrom(loaded, { now, tasks }),
    taskDone: new Map(tasks.map((task) => [task.id, task.status === 'done'])),
  };
}

export async function loadBoard(activeRoot: string, paths: LedgerPaths, now: Date): Promise<LoopBoard> {
  const warnings: string[] = [];
  const slugs = await listInitiativeSlugs(activeRoot);
  const [ledger, tree, sessions] = await Promise.all([
    loadLedger(paths, warnings),
    loadTree(paths, warnings),
    Promise.all(slugs.map((slug) => loadSessionSet(activeRoot, slug, now))),
  ]);
  const board = buildBoard({ ledger, tree, sessions, now });
  return { ...board, warnings: [...warnings, ...board.warnings] };
}
