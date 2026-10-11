import type { AdoptionOpportunity } from "./insights/adoption-registry.js";
import { patternId } from "./insights/post-filter.js";
import type { AdoptionRow, ToolAdoptionReport } from "./insights/tool-adoption.js";
import type { ToolGapRow, ToolGapsReport } from "./insights/tool-gaps.js";

/** One week's Q9 and Q10 answers, kept so next week's run can diff against them. */
export interface WeekSnapshot {
  gaps: ToolGapsReport;
  adoption: ToolAdoptionReport;
}

type GapChangeKind = "new" | "grown" | "shrunk" | "same" | "gone";

interface GapChange {
  kind: GapChangeKind;
  row: ToolGapRow;
  /** Last week's calls, null when the row is new. */
  previousCalls: number | null;
}

interface AdoptionChange {
  row: AdoptionRow;
  previousFlags: AdoptionRow["flags"];
}

interface WeekDiff {
  gaps: GapChange[];
  adoption: AdoptionChange[];
}

interface GapThreshold {
  minCalls: number;
  minSessions: number;
}

const DEFAULT_GAP_THRESHOLD: GapThreshold = { minCalls: 50, minSessions: 10 };

/** An open active-work task, as far as dedupe needs it. */
interface OpenTask {
  id: string;
  tags: readonly string[];
}

type TaskAction =
  | { kind: "add"; patternId: string; title: string; tags: string[]; body: string }
  | { kind: "note"; patternId: string; taskId: string; text: string };

const TOOL_GAP_TAG = "tool-gap";
const REMOVAL_AFTER_DAYS = 28;

const toolGapTag = (id: string) => `${TOOL_GAP_TAG}:${id}`;

/** Q9 rows are one per head and pattern; the pattern id alone repeats across heads. */
const rowKey = (row: Pick<ToolGapRow, "head" | "patternId">) => `${row.head}\u0000${row.patternId}`;

function gapKind(previous: ToolGapRow | undefined, current: ToolGapRow): GapChangeKind {
  if (previous === undefined) return "new";
  if (current.calls > previous.calls) return "grown";
  return current.calls < previous.calls ? "shrunk" : "same";
}

function sameFlags(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((flag) => b.includes(flag));
}

/** Without a previous week every gap is new and every flagged adoption row counts as a change. */
export function diffWeeks(previous: WeekSnapshot | null, current: WeekSnapshot): WeekDiff {
  const before = new Map((previous?.gaps.patterns ?? []).map((row) => [rowKey(row), row]));
  const seen = new Set(current.gaps.patterns.map(rowKey));
  const gaps: GapChange[] = current.gaps.patterns.map((row) => {
    const old = before.get(rowKey(row));
    return { kind: gapKind(old, row), row, previousCalls: old?.calls ?? null };
  });
  const gone = [...before.entries()].filter(([key]) => !seen.has(key)).map(([, row]): GapChange => ({ kind: "gone", row, previousCalls: row.calls }));
  const flagsBefore = new Map((previous?.adoption.opportunities ?? []).map((row) => [row.id, row.flags]));
  const adoption = current.adoption.opportunities
    .map((row) => ({ row, previousFlags: flagsBefore.get(row.id) ?? [] }))
    .filter(({ row, previousFlags }) => !sameFlags(row.flags, previousFlags));
  return { gaps: [...gaps, ...gone], adoption };
}

/** Every head and pattern the adoption registry already names as an old form. */
export function trackedPatterns(registry: readonly AdoptionOpportunity[]): Set<string> {
  return new Set(registry.flatMap((o) => o.old.patterns.map((pattern) => rowKey({ head: o.old.head, patternId: patternId(pattern) }))));
}

const counts = (row: ToolGapRow) => `${row.head} ${row.pattern}: ${row.calls} calls, ${row.sessions} sessions, ${row.agents} agents (${row.status})`;

function addAction(id: string, rows: readonly ToolGapRow[]): TaskAction {
  const first = rows[0]!;
  const heads = rows.map((row) => row.head).join(", ");
  const flags = [...new Set(rows.flatMap((row) => row.existingFlags))];
  const body = [
    `Agents piped \`${first.pattern}\` after ${heads} this week (Q9 ${id}).`,
    ...rows.map(counts),
    flags.length > 0 ? `Existing flags that already do the job: ${flags.join(" ")}.` : "No existing flag does the job.",
  ].join("\n");
  return { kind: "add", patternId: id, title: `Tool gap: \`${first.pattern}\` after ${heads}`, tags: [TOOL_GAP_TAG, toolGapTag(id), "item-114"], body };
}

function groupByPattern(rows: readonly ToolGapRow[]): Map<string, ToolGapRow[]> {
  const groups = new Map<string, ToolGapRow[]>();
  for (const row of rows) groups.set(row.patternId, [...(groups.get(row.patternId) ?? []), row]);
  return groups;
}

/**
 * At most one action per pattern id: a note on the open task tagged `tool-gap:<id>`, else an add.
 * A row below the threshold or already named in the adoption registry plans nothing.
 */
export function planTaskActions(gaps: readonly ToolGapRow[], tracked: ReadonlySet<string>, openTasks: readonly OpenTask[], threshold: GapThreshold = DEFAULT_GAP_THRESHOLD): TaskAction[] {
  const due = gaps.filter((row) => row.calls >= threshold.minCalls && row.sessions >= threshold.minSessions && !tracked.has(rowKey(row)));
  return [...groupByPattern(due)].map(([id, rows]): TaskAction => {
    const task = openTasks.find((t) => t.tags.includes(toolGapTag(id)));
    if (task === undefined) return addAction(id, rows);
    return { kind: "note", patternId: id, taskId: task.id, text: `This week: ${rows.map(counts).join("; ")}.` };
  });
}

function removalCandidates(adoption: ToolAdoptionReport): AdoptionRow[] {
  return adoption.opportunities.filter((row) => row.status === "shipped" && row.flags.includes("unused") && (row.daysSinceShip ?? 0) >= REMOVAL_AFTER_DAYS);
}

const section = (title: string, lines: readonly string[]) => [`${title} (${lines.length})`, ...(lines.length > 0 ? lines.map((line) => `- ${line}`) : ["- none"])].join("\n");

function actionLine(action: TaskAction): string {
  return action.kind === "add" ? `filed: ${action.title} [${toolGapTag(action.patternId)}]` : `noted on ${action.taskId} [${toolGapTag(action.patternId)}]`;
}

function adoptionLine(row: AdoptionRow, previousFlags?: AdoptionRow["flags"]): string {
  const flags = row.flags.length > 0 ? row.flags.join(" ") : "no flags";
  const was = previousFlags === undefined ? "" : ` (was ${previousFlags.length > 0 ? previousFlags.join(" ") : "no flags"})`;
  return `${row.id}: ${row.newForm}, ${row.newUses} new and ${row.oldUses} old uses, ${flags}${was}`;
}

/** One notice for the owner: it reports, and asks nothing (item 101). */
export function renderDigest(diff: WeekDiff, actions: readonly TaskAction[], adoption: ToolAdoptionReport): string {
  const changed = new Map(diff.adoption.map((c) => [c.row.id, c.previousFlags]));
  const judged = adoption.opportunities.filter((row) => row.status === "shipped" && !row.watching);
  return [
    `Tool-gap weekly notice, ${adoption.window.since.slice(0, 10)} to ${adoption.window.until.slice(0, 10)}. For information; no reply needed.`,
    section("New gaps", diff.gaps.filter((c) => c.kind === "new").map((c) => counts(c.row))),
    section("Task actions", actions.map(actionLine)),
    section("Adoption results", judged.map((row) => adoptionLine(row, changed.get(row.id)))),
    section(`Removal candidates, unused ${REMOVAL_AFTER_DAYS}+ days after ship`, removalCandidates(adoption).map((row) => adoptionLine(row))),
  ].join("\n\n") + "\n";
}
