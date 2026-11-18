/**
 * Freshness for readers of workspace documents (TP-4139).
 *
 * `context related` reads only the workspace half of the index, so it waits on
 * a workspace-only refresh, never on a transcript delta pass. A watcher on the
 * active root marks the workspace dirty; nothing is refreshed until a reader asks.
 * The watcher skips the miner root: the index database and its refresh lock live
 * there, so the daemon's own passes would otherwise mark the workspace dirty.
 */
import { existsSync } from 'node:fs';
import { watchTree, type TreeWatcher } from '@titan-design/daemon';
import type { Freshness } from '../session-index/freshness.js';
import type { WorkspaceGraph } from '../session-index/graph.js';
import { withRefreshLock } from '../session-index/refresh-lock.js';
import { isLockContention, withinBudget } from '../session-index/scheduler.js';
import { getActiveRoot, getMinerRoot } from '../utils/paths.js';
import { refreshWorkspace } from '../workspace-index/refresh.js';

export interface WorkspaceFreshness {
  /** The active root changed; the next workspace reader catches the index up first. */
  markDirty(): void;
  /** Fresh at once when nothing changed; otherwise waits on a workspace-only refresh within `budgetMs`. */
  ensure(budgetMs: number): Promise<Freshness>;
  /** Settles once no workspace refresh is running. */
  idle(): Promise<void>;
}

interface InfoLogger {
  info(obj: object, msg: string): void;
}

interface WorkspaceFreshnessOptions {
  log?: InfoLogger;
  now?: () => number;
}

interface WorkspaceRefreshState {
  dirty: boolean;
  /** Resolves true when the refresh succeeded. */
  inFlight: Promise<boolean> | null;
}

/** A change that lands while a refresh runs gets a follow-up refresh. */
export function createWorkspaceFreshness(
  refresh: () => Promise<unknown>,
  options: WorkspaceFreshnessOptions = {},
): WorkspaceFreshness {
  const state: WorkspaceRefreshState = { dirty: false, inFlight: null };
  const timed = withRefreshLog(refresh, options);
  return {
    markDirty: () => {
      state.dirty = true;
    },
    ensure: (budgetMs) =>
      !state.dirty && !state.inFlight
        ? Promise.resolve('fresh')
        : ensureWithinBudget(() => catchUpWorkspace(state, timed), budgetMs, options.log),
    idle: async () => {
      await state.inFlight;
    },
  };
}

/** A stale answer with the pass still running means the budget ran out, not that the refresh failed. */
async function ensureWithinBudget(
  catchUp: () => Promise<boolean>,
  budgetMs: number,
  log: InfoLogger | undefined,
): Promise<Freshness> {
  const pass = { settled: false };
  const freshness = await withinBudget(async () => {
    const ok = await catchUp();
    pass.settled = true;
    return ok;
  }, budgetMs);
  if (freshness === 'stale' && !pass.settled) {
    log?.info({ budgetMs }, 'workspace freshness stale: budget expired');
  }
  return freshness;
}

type RefreshOutcome = 'ok' | 'failed' | 'lock-held';

function refreshCounts(result: unknown): { files?: number; indexed?: number } {
  const { files, indexed } = (result ?? {}) as { files?: unknown; indexed?: unknown };
  return {
    ...(typeof files === 'number' ? { files } : {}),
    ...(typeof indexed === 'number' ? { indexed } : {}),
  };
}

/** One info line per refresh, so the reader budget can be re-measured from daemon.log. */
function withRefreshLog(
  refresh: () => Promise<unknown>,
  { log, now = Date.now }: WorkspaceFreshnessOptions,
): () => Promise<unknown> {
  if (!log) return refresh;
  const record = (started: number, outcome: RefreshOutcome, result?: unknown): void =>
    log.info({ ms: now() - started, ...refreshCounts(result), outcome }, 'workspace refresh');
  return async () => {
    const started = now();
    try {
      const result = await refresh();
      record(started, 'ok', result);
      return result;
    } catch (err) {
      record(started, isLockContention(err) ? 'lock-held' : 'failed');
      throw err;
    }
  };
}

/** A failed refresh leaves the workspace dirty, so the next reader tries again. */
function startWorkspaceRefresh(
  state: WorkspaceRefreshState,
  refresh: () => Promise<unknown>,
): Promise<boolean> {
  state.dirty = false;
  const run = refresh().then(
    () => true,
    () => {
      state.dirty = true;
      return false;
    },
  );
  const tracked = run.finally(() => {
    if (state.inFlight === tracked) state.inFlight = null;
  });
  state.inFlight = tracked;
  return tracked;
}

async function catchUpWorkspace(
  state: WorkspaceRefreshState,
  refresh: () => Promise<unknown>,
): Promise<boolean> {
  const ok = state.inFlight ? await state.inFlight : true;
  // Another reader may have started the follow-up while this one waited.
  if (state.inFlight) return state.inFlight;
  return state.dirty ? startWorkspaceRefresh(state, refresh) : ok;
}

interface WarnLogger extends InfoLogger {
  warn(obj: object, msg: string): void;
}

/** Short: marking dirty costs nothing, and a reader soon after a write should see it. */
const WORKSPACE_DEBOUNCE_MS = 200;

/** A missing active root is an ordinary state: the startup full pass indexes it once it exists. */
function watchWorkspace(
  root: string,
  workspace: WorkspaceFreshness,
  log: WarnLogger,
): TreeWatcher | null {
  if (!existsSync(root)) return null;
  try {
    return watchTree(root, () => workspace.markDirty(), {
      debounceMs: WORKSPACE_DEBOUNCE_MS,
      ignore: [getMinerRoot()],
      onError: (err) => log.warn({ err, root }, 'workspace watcher error'),
    });
  } catch (err) {
    log.warn({ err, root }, 'workspace watcher unavailable; related reads the last pass');
    return null;
  }
}

/** The workspace half alone; fails at once on a held lock, since a reader is waiting on it. */
function workspaceRefresh(
  currentGraph: () => Promise<WorkspaceGraph>,
  signal: AbortSignal,
): () => Promise<unknown> {
  return () =>
    withRefreshLock(
      async () => refreshWorkspace(await currentGraph(), { activeRoot: getActiveRoot() }),
      { retries: 0, signal },
    );
}

/** The daemon's workspace freshness over the graph `currentGraph` returns inside the lock, with its active-root watcher when the root exists. */
export function startWorkspaceFreshness(
  currentGraph: () => Promise<WorkspaceGraph>,
  signal: AbortSignal,
  log: WarnLogger,
): { workspace: WorkspaceFreshness; watcher: TreeWatcher | null } {
  const workspace = createWorkspaceFreshness(workspaceRefresh(currentGraph, signal), { log });
  return { workspace, watcher: watchWorkspace(getActiveRoot(), workspace, log) };
}
