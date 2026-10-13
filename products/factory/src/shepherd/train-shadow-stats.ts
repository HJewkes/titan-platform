import type { WorkflowRun } from "@titan-design/workflow";
import { inRange, inStepOrder, isoWeek, mergedAt, outsideAt, payloadOf, stepName, type StatsRange } from "./stats.js";
import type { TrainShadow } from "./train-shadow.js";

interface TrainShadowRow {
  repo: string;
  week: string;
  /** Land-time refreshes whose shadow was recorded. */
  shadows: number;
  /** Those a batch would have taken: the refreshing run itself was neither held nor stacked. */
  admissible: number;
  /** Mean batch size over the admissible shadows, the run plus its admitted peers, to two places; 0 with none. */
  meanBatch: number;
  maxBatch: number;
  /** Shadows whose PR and main's delta share no unit, before any dependency closure. */
  unitsDisjoint: number;
  /** Admissible shadows of runs that went on to merge, and those where another merge landed in between that was not a peer. */
  landed: number;
  outsideMoved: number;
  /** Land-time refresh heads whose CI reached a verdict, and those that went red after the pre-refresh head was green. */
  refreshJudged: number;
  refreshRed: number;
  /** `refreshRed / refreshJudged`, to three places; 0 with none judged. */
  refreshRedRate: number;
}

const FREEZE_HOLD_UPDATE = "update-branch:sh-freeze-hold:";

interface RefreshVerdict {
  at: number;
  red: boolean;
}

function verdictOf(ci: Record<string, unknown>): boolean | undefined {
  if (ci.verdict === "red") return true;
  if (ci.verdict === "green" || (ci.verdict === "behind" && ci.checksGreen === true)) return false;
  return undefined;
}

/**
 * Each land-time refresh's head and how its CI ended. A land-time refresh follows a ci-wait that saw the base move past
 * a green head, so the head before it was always green; the first verdict read at the refreshed head judges it.
 */
function refreshVerdicts(run: WorkflowRun): RefreshVerdict[] {
  const verdicts: RefreshVerdict[] = [];
  let lastCi: Record<string, unknown> | undefined;
  let refreshed: { head: unknown; at: number } | undefined;
  for (const { key, result } of inStepOrder(run)) {
    const payload = payloadOf(result);
    if (stepName(key) === "update-branch" && !key.startsWith(FREEZE_HOLD_UPDATE) && lastCi?.baseMoved === true) refreshed = { head: payload.headSha, at: Date.parse(result.completedAt) };
    if (stepName(key) !== "ci-wait") continue;
    lastCi = payload;
    const red = refreshed?.head === payload.headSha ? verdictOf(payload) : undefined;
    if (refreshed && red !== undefined) verdicts.push({ at: refreshed.at, red });
    if (red !== undefined) refreshed = undefined;
  }
  return verdicts;
}

interface Merge {
  runId: string;
  at: number;
}

function mergesByRepo(runs: readonly WorkflowRun[]): Map<string, Merge[]> {
  const byRepo = new Map<string, Merge[]>();
  for (const run of runs) {
    const repo = run.params.repo?.toLowerCase();
    const at = mergedAt(run) ?? outsideAt(run);
    if (repo && at !== undefined) byRepo.set(repo, [...(byRepo.get(repo) ?? []), { runId: run.id, at }]);
  }
  return byRepo;
}

/** True when a merge that was neither this run nor one of its peers landed between the shadow and this run's merge. */
function movedOutside(shadow: TrainShadow, merged: number, merges: readonly Merge[]): boolean {
  const batch = new Set([shadow.runId, ...shadow.peers.map((peer) => peer.runId)]);
  const at = Date.parse(shadow.at);
  return merges.some((merge) => !batch.has(merge.runId) && merge.at > at && merge.at < merged);
}

const emptyRow = (repo: string, week: string): TrainShadowRow => ({ repo, week, shadows: 0, admissible: 0, meanBatch: 0, maxBatch: 0, unitsDisjoint: 0, landed: 0, outsideMoved: 0, refreshJudged: 0, refreshRed: 0, refreshRedRate: 0 });

function addShadow(row: TrainShadowRow, shadow: TrainShadow, merged: number | undefined, merges: readonly Merge[]): void {
  row.shadows++;
  if (shadow.disjoint === "units-disjoint") row.unitsDisjoint++;
  if (shadow.selfExcluded !== undefined) return;
  const size = 1 + shadow.peers.length;
  row.meanBatch = (row.meanBatch * row.admissible + size) / (row.admissible + 1);
  row.admissible++;
  row.maxBatch = Math.max(row.maxBatch, size);
  if (merged === undefined) return;
  row.landed++;
  if (movedOutside(shadow, merged, merges)) row.outsideMoved++;
}

/**
 * Per repo and ISO week: what a merge-train batch would have held at each land-time refresh, and how often a refresh
 * head went red after a green pre-refresh head. A merge into main by anyone Shepherd never registered is not seen.
 */
export function trainShadowStats(shadows: readonly TrainShadow[], runs: readonly WorkflowRun[], range: StatsRange = {}): TrainShadowRow[] {
  const rows = new Map<string, TrainShadowRow>();
  const rowAt = (repo: string, at: number) => {
    const week = isoWeek(at);
    const row = rows.get(`${repo} ${week}`) ?? emptyRow(repo, week);
    return (rows.set(`${repo} ${week}`, row), row);
  };
  const byId = new Map(runs.map((run) => [run.id, run]));
  const merges = mergesByRepo(runs);
  for (const shadow of shadows.filter((s) => inRange(Date.parse(s.at), range))) {
    const run = byId.get(shadow.runId);
    addShadow(rowAt(shadow.repo, Date.parse(shadow.at)), shadow, run && mergedAt(run), merges.get(shadow.repo) ?? []);
  }
  for (const run of runs) {
    const repo = run.params.repo?.toLowerCase();
    if (!repo) continue;
    for (const verdict of refreshVerdicts(run).filter((v) => inRange(v.at, range))) {
      const row = rowAt(repo, verdict.at);
      row.refreshJudged++;
      if (verdict.red) row.refreshRed++;
    }
  }
  return [...rows.values()].map(rounded).sort((a, b) => a.repo.localeCompare(b.repo) || a.week.localeCompare(b.week));
}

const rounded = (row: TrainShadowRow): TrainShadowRow => ({ ...row, meanBatch: Math.round(row.meanBatch * 100) / 100, refreshRedRate: row.refreshJudged === 0 ? 0 : Math.round((row.refreshRed / row.refreshJudged) * 1000) / 1000 });

/** The human report's section; empty when no shadow or refresh verdict fell in range. */
export function formatTrainShadow(rows: readonly TrainShadowRow[]): string[] {
  const lines = rows.map((r) => `${r.repo}  ${r.week}  shadows ${r.shadows}  admissible ${r.admissible}  mean batch ${r.meanBatch}  max ${r.maxBatch}  units-disjoint ${r.unitsDisjoint}  outside moves ${r.outsideMoved}/${r.landed}  refresh red ${r.refreshRed}/${r.refreshJudged} (${(r.refreshRedRate * 100).toFixed(1)}%)`);
  return lines.length === 0 ? [] : ["", "merge-train shadow:", ...lines];
}
