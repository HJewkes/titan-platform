import {
  accreteSymbols,
  aggregateChurnWindows,
  authorLinesByPath,
  computeOwnership,
  entriesWithin,
  loadChurnResult,
  loadFileEditsResult,
  loadFirstSeenResult,
  type ChurnEntry,
  type ChurnWindow,
  type FileEdit,
  type PathChurn,
  summarizeOwnership,
  type SymbolSpan,
} from "./history/index.js";
import { groupTestsBySource, type TestSourceLink } from "./analysis/test-linker.js";
import { computeRecencyWindows, round3, windowSuffix } from "./history-recency.js";
import type { GraphMetric, GraphNode } from "./types.js";

export interface HistoryMetricsOptions {
  /** Primary window: scopes ownership. Default 30. */
  churnWindowDays?: number;
  /** Windows to store churn and recency for; default {@link DEFAULT_CHURN_WINDOWS}, primary always included. */
  churnWindows?: number[];
  /** Also store an all-time `lifetime` window over full git history. */
  includeLifetime?: boolean;
  /** Epoch seconds that windows end at; defaults to the current time. */
  nowEpoch?: number;
  /** Read history up to this rev instead of HEAD; pair it with the rev's commit time as `nowEpoch`. */
  rev?: string;
  /** Day windows to store per-symbol accretion for; default {@link DEFAULT_ACCRETION_WINDOWS}, [] turns it off. */
  accretionWindows?: number[];
  /** Task ids read from commit subjects for `symbol_task_ids_{w}`; default `DEFAULT_TASK_ID_PATTERN`. */
  taskIdPattern?: RegExp;
}

/** Re-edits of one function across distinct tasks within a week is the accretion signal the slop audit asked for. */
export const DEFAULT_ACCRETION_WINDOWS = [7];

/** Windows the dashboard switcher offers; churn is stored for each by default. */
export const DEFAULT_CHURN_WINDOWS = [30, 90, 180];

/** De-duped, ascending windows including the primary, with `lifetime` last (widest) when requested. */
export function resolveChurnWindows(
  requested: number[] | undefined,
  primaryWindow: number,
  includeLifetime: boolean,
): ChurnWindow[] {
  const base = requested && requested.length > 0 ? requested : DEFAULT_CHURN_WINDOWS;
  const finite = [...new Set([primaryWindow, ...base])].filter((w) => w > 0).sort((a, b) => a - b);
  return includeLifetime ? [...finite, "lifetime"] : finite;
}

export interface LoadedHistory {
  metrics: GraphMetric[];
  /** Churn entries inside the primary window, which also scopes test-coverage linking and ownership. */
  primaryEntries: readonly ChurnEntry[];
  /**
   * Why history is missing or partial: the churn log overflowed or git failed (no metrics, no entries),
   * or the first-seen log did (metrics without age discount). Empty when everything loaded.
   */
  warnings: readonly string[];
}

/**
 * Git-history metrics for a snapshot's file nodes: churn and recency per window,
 * ownership for the primary window (and lifetime when requested). Node ids are
 * the history engine's repo-relative paths, because both are rooted at `idRoot`.
 * Returns [] when git or history is unavailable; a log that overflowed or failed is reported by
 * {@link loadHistoryMetrics} as a warning, which this metrics-only view drops.
 */
export function buildHistoryMetrics(
  nodes: Iterable<GraphNode>,
  idRoot: string,
  options: HistoryMetricsOptions = {},
): GraphMetric[] {
  return loadHistoryMetrics(nodes, idRoot, options)?.metrics ?? [];
}

/** {@link buildHistoryMetrics} plus the primary-window entries it read. Null when `idRoot` is not a git checkout;
 * `warnings` (and no metrics) when git ran but its log overflowed or failed. */
export function loadHistoryMetrics(
  nodes: Iterable<GraphNode>,
  idRoot: string,
  options: HistoryMetricsOptions = {},
): LoadedHistory | null {
  const nodeList = [...nodes];
  const knownPaths = collectFileIds(nodeList);
  const primaryWindow = options.churnWindowDays ?? 30;
  const windows = resolveChurnWindows(options.churnWindows, primaryWindow, options.includeLifetime === true);
  const load = loadWidestChurn(idRoot, windows, options);
  if (!load.ok) return load.reason === "not-git" ? null : { metrics: [], primaryEntries: [], warnings: [historyWarning("churn", load)] };
  const wide = load.value;
  const nowEpoch = options.nowEpoch ?? Math.floor(Date.now() / 1000);
  const churnByWindow = aggregateChurnWindows(wide, windows, nowEpoch, knownPaths);
  const primaryEntries = windows.at(-1) === primaryWindow ? wide : entriesWithin(wide, primaryWindow, nowEpoch);
  const warnings: string[] = [];
  const metrics = [
    ...churnMetrics(churnByWindow),
    ...ownershipMetrics(primaryEntries, primaryWindow, knownPaths),
    ...recencyMetrics({ idRoot, rev: options.rev, knownPaths, nowEpoch, warnings }, churnByWindow),
    ...accretionMetrics({ idRoot, nodes: nodeList, options, nowEpoch, warnings }),
  ];
  // Lifetime ownership is the dominant owner over full history; `wide` is full history when lifetime is on.
  if (options.includeLifetime === true) metrics.push(...ownershipMetrics(wide, "lifetime", knownPaths));
  return { metrics, primaryEntries, warnings };
}

/** Load the widest window once so each narrower one is a slice of it; lifetime sorts widest. */
function loadWidestChurn(idRoot: string, windows: readonly ChurnWindow[], options: HistoryMetricsOptions) {
  return loadChurnResult({ repoRoot: idRoot, windowDays: windows.at(-1)!, rev: options.rev, untilEpoch: options.nowEpoch });
}

export function collectFileIds(nodes: Iterable<GraphNode>): Set<string> {
  const out = new Set<string>();
  for (const n of nodes) {
    if (n.kind === "file") out.add(n.id);
  }
  return out;
}

/** Name one window's per-path churn as `churn_{w}`, `churn_{w}_commits`, `churn_{w}_authors`. */
export function churnMetrics(churnByWindow: ReadonlyMap<ChurnWindow, ReadonlyMap<string, PathChurn>>): GraphMetric[] {
  const out: GraphMetric[] = [];
  for (const [window, byPath] of churnByWindow) {
    const suffix = windowSuffix(window);
    for (const [nodeId, churn] of byPath) {
      out.push(
        { nodeId, name: `churn_${suffix}`, value: churn.lines, unit: "lines" },
        { nodeId, name: `churn_${suffix}_commits`, value: churn.commits, unit: "count" },
        { nodeId, name: `churn_${suffix}_authors`, value: churn.authors, unit: "count" },
      );
    }
  }
  return out;
}

/** Name ownership as `bus_factor_{w}` and `top_author_share_{w}` (rounded to 3 places). */
export function ownershipMetrics(
  entries: readonly ChurnEntry[],
  window: ChurnWindow,
  knownPaths?: ReadonlySet<string>,
): GraphMetric[] {
  const suffix = windowSuffix(window);
  const out: GraphMetric[] = [];
  for (const [nodeId, owner] of computeOwnership(entries, { knownPaths })) {
    out.push(
      { nodeId, name: `bus_factor_${suffix}`, value: owner.busFactor, unit: "count" },
      { nodeId, name: `top_author_share_${suffix}`, value: round3(owner.topAuthorShare), unit: "ratio" },
    );
  }
  return out;
}

export interface TestCoverageOwnershipOptions {
  /** Window named in the metric suffix. Default 30. */
  windowDays?: ChurnWindow;
  /** Coverage threshold for bus factor (default 0.5 = 50% of churn). */
  busFactorThreshold?: number;
}

/**
 * Bus-factor / top-author-share of the *test coverage* for each source, keyed
 * on the source node. Aggregates churn authorship across all test files linked
 * to a source (via the two-pass linker) and summarises it the same way as
 * production ownership — so a file can read as well-spread on production code
 * yet a single-author silo on its tests (or vice versa). Emitted only for
 * sources with at least one linked test that has churn in the window.
 */
export function computeTestCoverageOwnership(
  entries: readonly ChurnEntry[],
  links: readonly TestSourceLink[],
  options: TestCoverageOwnershipOptions = {},
): GraphMetric[] {
  const suffix = windowSuffix(options.windowDays ?? 30);
  const testsBySource = groupTestsBySource(links);
  const testIds = new Set<string>();
  for (const tests of testsBySource.values()) {
    for (const t of tests) testIds.add(t);
  }
  const linesByTest = authorLinesByPath(entries, testIds);
  const out: GraphMetric[] = [];
  for (const [nodeId, tests] of testsBySource) {
    const summary = summarizeOwnership(mergeAuthorChurn(tests, linesByTest), options.busFactorThreshold);
    if (summary === null) continue;
    out.push(
      { nodeId, name: `test_bus_factor_${suffix}`, value: summary.busFactor, unit: "count" },
      { nodeId, name: `test_top_author_share_${suffix}`, value: round3(summary.topAuthorShare), unit: "ratio" },
    );
  }
  return out;
}

/** Sum per-author churn across a set of test files into one author tally. */
function mergeAuthorChurn(
  tests: ReadonlySet<string>,
  linesByTest: ReadonlyMap<string, Map<string, number>>,
): Map<string, number> {
  const byAuthor = new Map<string, number>();
  for (const testId of tests) {
    const fileAuthors = linesByTest.get(testId);
    if (!fileAuthors) continue;
    for (const [author, lines] of fileAuthors) {
      byAuthor.set(author, (byAuthor.get(author) ?? 0) + lines);
    }
  }
  return byAuthor;
}

/** Recency for files that churned in each window; an unknown first-seen date still yields recency 1. */
function recencyMetrics(
  at: { idRoot: string; rev: string | undefined; knownPaths: ReadonlySet<string>; nowEpoch: number; warnings: string[] },
  churnByWindow: ReadonlyMap<ChurnWindow, ReadonlyMap<string, PathChurn>>,
): GraphMetric[] {
  const churnedByWindow = new Map<ChurnWindow, ReadonlySet<string>>();
  for (const [window, byPath] of churnByWindow) {
    if (byPath.size > 0) churnedByWindow.set(window, new Set(byPath.keys()));
  }
  if (churnedByWindow.size === 0) return [];
  const load = loadFirstSeenResult({ repoRoot: at.idRoot, knownPaths: at.knownPaths, rev: at.rev });
  if (!load.ok && load.reason !== "not-git") at.warnings.push(historyWarning("first-seen", load));
  return computeRecencyWindows(load.ok ? load.value : new Map<string, number>(), churnedByWindow, at.nowEpoch);
}

interface AccretionInput {
  idRoot: string;
  nodes: readonly GraphNode[];
  options: HistoryMetricsOptions;
  nowEpoch: number;
  warnings: string[];
}

/** `symbol_task_ids_{w}` and `symbol_edit_commits_{w}` per edited symbol, from one patch log over the widest window. */
function accretionMetrics(at: AccretionInput): GraphMetric[] {
  const windows = [...new Set(at.options.accretionWindows ?? DEFAULT_ACCRETION_WINDOWS)].filter((w) => w > 0);
  if (windows.length === 0) return [];
  const load = loadFileEditsResult({
    repoRoot: at.idRoot,
    windowDays: Math.max(...windows),
    rev: at.options.rev,
    untilEpoch: at.options.nowEpoch,
    taskIdPattern: at.options.taskIdPattern,
  });
  if (!load.ok) {
    if (load.reason !== "not-git") at.warnings.push(historyWarning("patch", load));
    return [];
  }
  const spans = symbolSpansByFile(at.nodes);
  return windows.flatMap((w) => symbolAccretionMetrics(editsWithin(load.value, w, at.nowEpoch), spans, w));
}

function editsWithin(edits: readonly FileEdit[], windowDays: number, nowEpoch: number): FileEdit[] {
  const cutoff = nowEpoch - windowDays * 86400;
  return edits.filter((e) => e.epoch >= cutoff);
}

/** Name per-symbol accretion for one window as `symbol_task_ids_{w}` and `symbol_edit_commits_{w}`. */
export function symbolAccretionMetrics(
  edits: readonly FileEdit[],
  spansByFile: ReadonlyMap<string, readonly SymbolSpan[]>,
  window: number,
): GraphMetric[] {
  const suffix = windowSuffix(window);
  const out: GraphMetric[] = [];
  for (const [nodeId, acc] of accreteSymbols(edits, spansByFile)) {
    out.push(
      { nodeId, name: `symbol_task_ids_${suffix}`, value: acc.taskIds.size, unit: "count" },
      { nodeId, name: `symbol_edit_commits_${suffix}`, value: acc.commits.size, unit: "count" },
    );
  }
  return out;
}

/** Symbols that carry a line span (functions, methods, classes), grouped by their file id. */
export function symbolSpansByFile(nodes: Iterable<GraphNode>): Map<string, SymbolSpan[]> {
  const out = new Map<string, SymbolSpan[]>();
  for (const n of nodes) {
    const start = n.attrs?.startLine;
    const end = n.attrs?.endLine;
    if (n.kind !== "symbol" || !n.parentId || typeof start !== "number" || typeof end !== "number") continue;
    const bucket = out.get(n.parentId) ?? [];
    bucket.push({ id: n.id, startLine: start, endLine: end });
    out.set(n.parentId, bucket);
  }
  return out;
}

function historyWarning(log: "churn" | "first-seen" | "patch", failure: { reason: string; detail: string }): string {
  return `git ${log} log ${failure.reason}: ${failure.detail}; history metrics are incomplete`;
}
