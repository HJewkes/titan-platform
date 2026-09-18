import {
  aggregateChurnWindows,
  computeOwnership,
  entriesWithin,
  loadChurnEntries,
  loadFileFirstSeen,
  type ChurnEntry,
  type ChurnWindow,
  type PathChurn,
} from "./history/index.js";
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
}

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

/**
 * Git-history metrics for a snapshot's file nodes: churn and recency per window,
 * ownership for the primary window (and lifetime when requested). Node ids are
 * the history engine's repo-relative paths, because both are rooted at `idRoot`.
 * Returns [] when git or history is unavailable.
 */
export function buildHistoryMetrics(
  nodes: Iterable<GraphNode>,
  idRoot: string,
  options: HistoryMetricsOptions = {},
): GraphMetric[] {
  const knownPaths = collectFileIds(nodes);
  const primaryWindow = options.churnWindowDays ?? 30;
  const windows = resolveChurnWindows(options.churnWindows, primaryWindow, options.includeLifetime === true);
  // Load the widest window once and slice it per window; lifetime sorts widest.
  const wide = loadChurnEntries({ repoRoot: idRoot, windowDays: windows[windows.length - 1]! });
  if (wide === null) return [];
  const nowEpoch = options.nowEpoch ?? Math.floor(Date.now() / 1000);
  const churnByWindow = aggregateChurnWindows(wide, windows, nowEpoch, knownPaths);
  const primaryEntries = windows.at(-1) === primaryWindow ? wide : entriesWithin(wide, primaryWindow, nowEpoch);
  const out = [
    ...churnMetrics(churnByWindow),
    ...ownershipMetrics(primaryEntries, primaryWindow, knownPaths),
    ...recencyMetrics(idRoot, churnByWindow, knownPaths, nowEpoch),
  ];
  // Lifetime ownership is the dominant owner over full history; `wide` is full history when lifetime is on.
  if (options.includeLifetime === true) out.push(...ownershipMetrics(wide, "lifetime", knownPaths));
  return out;
}

function collectFileIds(nodes: Iterable<GraphNode>): Set<string> {
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

/** Recency for files that churned in each window; an unknown first-seen date still yields recency 1. */
function recencyMetrics(
  idRoot: string,
  churnByWindow: ReadonlyMap<ChurnWindow, ReadonlyMap<string, PathChurn>>,
  knownPaths: ReadonlySet<string>,
  nowEpoch: number,
): GraphMetric[] {
  const churnedByWindow = new Map<ChurnWindow, ReadonlySet<string>>();
  for (const [window, byPath] of churnByWindow) {
    if (byPath.size > 0) churnedByWindow.set(window, new Set(byPath.keys()));
  }
  if (churnedByWindow.size === 0) return [];
  const firstSeen = loadFileFirstSeen({ repoRoot: idRoot, knownPaths }) ?? new Map<string, number>();
  return computeRecencyWindows(firstSeen, churnedByWindow, nowEpoch);
}
