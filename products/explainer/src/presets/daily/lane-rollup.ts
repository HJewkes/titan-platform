import type { DigestItem } from "../../digest.js";
import type { Lane, LanesFile } from "../../lanes-schema.js";
import { attributeLanes, namedCount, rankThreads, threadsOf, type LanedPr, type Thread } from "./lanes.js";
import type { DayWindow } from "./session-source.js";
import type { SnapshotTask } from "./task-snapshot.js";

/** Where each merged PR is spoken for: named in its thread, or counted in its lane's rollup fact. */
export interface CoverageEntry {
  pr: string;
  lane: string;
  thread: string;
  named: boolean;
}

export interface LaneCoverage {
  id: string;
  label: string;
  /** The rollup fact a script cites to count the lane's unnamed PRs. */
  rollup: string;
  merged: number;
  named: string[];
  counted: number;
}

/** `coverage.json`: every merged PR of the window under exactly one lane. */
export interface Coverage {
  schema: "daily-coverage/v1";
  merged: number;
  lanes: LaneCoverage[];
  prs: CoverageEntry[];
}

export interface LaneRollupResult {
  /** The merged PR items, each now carrying its lane, role and goal. */
  prs: DigestItem[];
  rollups: DigestItem[];
  coverage: Coverage;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const threadTitle = (thread: Thread) => thread.task?.title ?? thread.prs[0]!.title;

function rollupItem(id: string, title: string, summary: string, window: DayWindow, extra: Partial<DigestItem> = {}): DigestItem {
  return { id, kind: "rollup", title, summary, at: window.since, priority: "P1", ...extra };
}

function laneSummary(named: readonly Thread[], counted: readonly Thread[]): string {
  const countedPrs = counted.flatMap((thread) => thread.prs);
  const sideQuests = counted.filter((thread) => thread.role === "side-quest").reduce((sum, thread) => sum + thread.prs.length, 0);
  const rest = countedPrs.length === 0 ? "" : `; and ${plural(countedPrs.length, "smaller merge")}, ${sideQuests} of them side quests`;
  return `named: ${named.map(threadTitle).join("; ")}${rest}`;
}

function laneFacts(lane: Lane, ranked: readonly Thread[], k: number, window: DayWindow): { items: DigestItem[]; coverage: LaneCoverage } {
  const named = ranked.slice(0, k);
  const counted = ranked.slice(k);
  const prs = ranked.flatMap((thread) => thread.prs);
  const sideQuests = ranked.filter((thread) => thread.role === "side-quest").reduce((sum, thread) => sum + thread.prs.length, 0);
  const goalsMoved = new Set(ranked.flatMap((thread) => (thread.goal ? [thread.goal] : []))).size;
  const id = `lane/${lane.id}/rollup`;
  const title = `${lane.label}: ${prs.length} merged, ${plural(sideQuests, "side quest")}, ${plural(goalsMoved, "goal")} moved`;
  const goals = lane.goals.map((goal) => {
    const toward = ranked.filter((thread) => thread.goal === goal.id);
    const merged = toward.reduce((sum, thread) => sum + thread.prs.length, 0);
    const summary = merged === 0 ? "nothing merged toward it" : `${merged} merged toward it across ${plural(toward.length, "thread")}`;
    return rollupItem(`goal/${lane.id}/${goal.id}`, goal.line, summary, window, { lane: lane.id, goal: goal.id });
  });
  const coverage = { id: lane.id, label: lane.label, rollup: id, merged: prs.length, named: named.map((thread) => thread.id), counted: counted.reduce((sum, thread) => sum + thread.prs.length, 0) };
  return { items: [rollupItem(id, title, laneSummary(named, counted), window, { lane: lane.id }), ...goals], coverage };
}

/** The top closed threads across lanes, at most `perLane` from any one lane. */
export function pickShips(ranked: readonly Thread[], ships: LanesFile["ships"]): Thread[] {
  const perLane = new Map<string, number>();
  const picked: Thread[] = [];
  for (const thread of ranked.filter((row) => row.closed)) {
    if (picked.length >= ships.count) break;
    const taken = perLane.get(thread.lane) ?? 0;
    if (taken >= ships.perLane) continue;
    perLane.set(thread.lane, taken + 1);
    picked.push(thread);
  }
  return picked;
}

function shipItem(thread: Thread, window: DayWindow): DigestItem {
  const lead = thread.prs[0]!;
  const packages = [...new Set(thread.prs.flatMap((pr) => pr.packages ?? []))].sort();
  const summary = [lead.outcome, packages.length > 0 ? `touches ${packages.join(", ")}` : undefined, plural(thread.prs.length, "PR")].filter(Boolean).join(" · ");
  return rollupItem(`ship/${thread.id}`, threadTitle(thread), summary, window, { lane: thread.lane, role: thread.role, packages, ...(thread.goal ? { goal: thread.goal } : {}) });
}

const withLane = (pr: LanedPr): DigestItem => ({ ...pr.item, lane: pr.lane, role: pr.role, ...(pr.goal ? { goal: pr.goal } : {}) });

const entries = (ranked: readonly Thread[], k: number): CoverageEntry[] =>
  ranked.flatMap((thread, i) => thread.prs.map((pr) => ({ pr: pr.id, lane: thread.lane, thread: thread.id, named: i < k })));

/** Lanes, goals, ships and the day's total as rollup facts, plus the coverage manifest the script is checked against. */
export function laneRollups(items: readonly DigestItem[], tasks: readonly SnapshotTask[], file: LanesFile, window: DayWindow): LaneRollupResult {
  const laned = attributeLanes(items, tasks, file);
  const threads = threadsOf(laned, window);
  const rollups: DigestItem[] = [];
  const lanes: LaneCoverage[] = [];
  const prs: CoverageEntry[] = [];
  for (const lane of file.lanes) {
    const ranked = rankThreads(threads.filter((thread) => thread.lane === lane.id), file.rank);
    if (ranked.length === 0) continue;
    const k = namedCount(ranked.reduce((sum, thread) => sum + thread.prs.length, 0), laned.length, file.named);
    const facts = laneFacts(lane, ranked, k, window);
    rollups.push(...facts.items);
    lanes.push(facts.coverage);
    prs.push(...entries(ranked, k));
  }
  rollups.push(...pickShips(rankThreads(threads, file.rank), file.ships).map((thread) => shipItem(thread, window)));
  const repos = new Set(laned.map((pr) => pr.item.repo)).size;
  rollups.push(rollupItem("day/rollup", `${laned.length} merged across ${plural(repos, "repo")}`, `${plural(lanes.length, "lane")} moved`, window));
  return { prs: laned.map(withLane), rollups, coverage: { schema: "daily-coverage/v1", merged: laned.length, lanes, prs } };
}
