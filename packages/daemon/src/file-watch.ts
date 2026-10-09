/**
 * Recursive filesystem watcher.
 *
 * On macOS and Windows one native recursive `fs.watch` handle on the root covers the tree.
 * Elsewhere (Linux) recursive support is version-dependent, so we watch the root plus every
 * subdirectory ourselves and re-scan to attach to freshly-created dirs whenever a change
 * lands. Change events are debounced into a single callback so a burst of atomic writes
 * (temp file + rename) collapses into one.
 */
import { watch, existsSync, readdirSync, promises as fs, type FSWatcher } from "node:fs";
import path from "node:path";

/**
 * macOS and Windows implement recursive `fs.watch` natively; on Linux it is
 * version-dependent, so there the tree is covered one directory at a time.
 *
 * The difference is not cosmetic. One handle per directory means one FSEvents
 * teardown per directory at shutdown, each a semaphore round-trip serialized on
 * the main thread — measured at 7.9ms across 1,593 directories, which is 12.6s
 * of a daemon's SIGTERM handler (TP-37).
 */
const RECURSIVE_WATCH = process.platform === "darwin" || process.platform === "win32";

export interface WatchTreeOptions {
  /** Coalesce bursts of events within this window (ms). */
  debounceMs?: number;
  /** Surface watcher errors (e.g. EMFILE) without crashing the host process. */
  onError?: (err: unknown) => void;
}

export interface TreeWatcher {
  close: () => void;
  /** Whether a watcher is currently attached to `dir`. */
  isWatching: (dir: string) => boolean;
  /**
   * Resolve once a watcher is attached to `dir` — the real "this path is now covered"
   * signal, so callers never have to guess with a sleep. Resolves `true` immediately if
   * already attached, `false` if `timeoutMs` elapses or the tree watcher closes first.
   */
  whenWatching: (dir: string, timeoutMs?: number) => Promise<boolean>;
}

const DEFAULT_DEBOUNCE_MS = 200;
const DEFAULT_ATTACH_TIMEOUT_MS = 5_000;

/**
 * Watch `root` and all nested directories, invoking `onChange` (debounced) whenever any
 * file or directory under the tree changes. `close()` tears down every watcher.
 */
export function watchTree(root: string, onChange: () => void, options: WatchTreeOptions = {}): TreeWatcher {
  const tree = createTree(root, onChange, options);
  watchDir(tree, root, RECURSIVE_WATCH);
  if (!RECURSIVE_WATCH) attachBelowSync(tree.crawl, root);
  return {
    isWatching: (dir) => covered(tree, dir),
    whenWatching: (dir, timeoutMs) => whenWatching(tree, dir, timeoutMs),
    close: () => closeTree(tree),
  };
}

/** Everything one `watchTree` call shares between its watchers, timers and waiters. */
interface Tree {
  root: string;
  onChange: () => void;
  options: WatchTreeOptions;
  debounceMs: number;
  watchers: Map<string, FSWatcher>;
  attachWaiters: Map<string, Set<() => void>>;
  debounceTimer: NodeJS.Timeout | null;
  rescanTimer: NodeJS.Timeout | null;
  closed: boolean;
  crawl: Crawl;
}

function createTree(root: string, onChange: () => void, options: WatchTreeOptions): Tree {
  const tree: Tree = {
    root,
    onChange,
    options,
    debounceMs: options.debounceMs ?? DEFAULT_DEBOUNCE_MS,
    watchers: new Map(),
    attachWaiters: new Map(),
    debounceTimer: null,
    rescanTimer: null,
    closed: false,
    crawl: {
      isClosed: () => tree.closed,
      isWatched: (dir) => tree.watchers.has(dir),
      watchDir: (dir) => watchDir(tree, dir),
      fire: () => fire(tree),
      onError: (err) => tree.options.onError?.(err),
    },
  };
  return tree;
}

function fire(tree: Tree): void {
  if (tree.closed) return;
  if (tree.debounceTimer) clearTimeout(tree.debounceTimer);
  tree.debounceTimer = setTimeout(() => {
    tree.debounceTimer = null;
    if (!tree.closed) tree.onChange();
  }, tree.debounceMs);
}

/**
 * Whether writes under `dir` reach the change feed. Per-directory when we attach
 * per directory; under a recursive root watch every existing path beneath it is
 * covered, with no handle of its own to look up.
 */
function covered(tree: Tree, dir: string): boolean {
  if (tree.closed) return false;
  if (tree.watchers.has(dir)) return true;
  if (!RECURSIVE_WATCH) return false;
  return isStrictlyBelow(tree.root, dir) && existsSync(dir);
}

function isStrictlyBelow(root: string, dir: string): boolean {
  const rel = path.relative(root, dir);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function notifyAttached(tree: Tree, dir: string): void {
  const waiters = tree.attachWaiters.get(dir);
  if (!waiters) return;
  tree.attachWaiters.delete(dir);
  for (const resolve of waiters) resolve();
}

/** Under a recursive watch nothing "attaches", so coverage is rechecked on each event. */
function notifyNowCovered(tree: Tree): void {
  for (const dir of [...tree.attachWaiters.keys()]) if (covered(tree, dir)) notifyAttached(tree, dir);
}

function scheduleRescan(tree: Tree): void {
  if (tree.closed || tree.rescanTimer) return;
  tree.rescanTimer = setTimeout(() => {
    tree.rescanTimer = null;
    void attachBelow(tree.crawl, tree.root);
  }, tree.debounceMs);
}

function watchDir(tree: Tree, dir: string, recursive = false): void {
  if (tree.closed || tree.watchers.has(dir)) return;
  const w = openWatcher(tree, dir, recursive);
  if (!w) return;
  w.on("error", (err) => tree.options.onError?.(err));
  w.on("change", () => onWatcherChange(tree, recursive));
  tree.watchers.set(dir, w);
  notifyAttached(tree, dir);
}

function openWatcher(tree: Tree, dir: string, recursive: boolean): FSWatcher | null {
  try {
    return watch(dir, { persistent: false, recursive });
  } catch (err) {
    tree.options.onError?.(err);
    return null;
  }
}

function onWatcherChange(tree: Tree, recursive: boolean): void {
  fire(tree);
  // A new subdirectory may have appeared. One recursive handle already covers
  // it, so only the per-directory mode has to go attach to it.
  if (recursive) notifyNowCovered(tree);
  else scheduleRescan(tree);
}

function whenWatching(tree: Tree, dir: string, timeoutMs = DEFAULT_ATTACH_TIMEOUT_MS): Promise<boolean> {
  if (covered(tree, dir)) return Promise.resolve(true);
  if (tree.closed) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      tree.attachWaiters.get(dir)?.delete(done);
      resolve(covered(tree, dir));
    };
    const timer = setTimeout(done, timeoutMs);
    timer.unref?.();
    addWaiter(tree, dir, done);
  });
}

function addWaiter(tree: Tree, dir: string, waiter: () => void): void {
  const waiters = tree.attachWaiters.get(dir) ?? new Set<() => void>();
  waiters.add(waiter);
  tree.attachWaiters.set(dir, waiters);
}

function closeTree(tree: Tree): void {
  tree.closed = true;
  if (tree.debounceTimer) clearTimeout(tree.debounceTimer);
  if (tree.rescanTimer) clearTimeout(tree.rescanTimer);
  for (const w of tree.watchers.values()) w.close();
  tree.watchers.clear();
  for (const waiters of tree.attachWaiters.values()) for (const resolve of waiters) resolve();
  tree.attachWaiters.clear();
}

/** What the per-directory crawl needs from its watcher. Only reached where `RECURSIVE_WATCH` is false. */
interface Crawl {
  isClosed: () => boolean;
  isWatched: (dir: string) => boolean;
  watchDir: (dir: string) => void;
  fire: () => void;
  onError: (err: unknown) => void;
}

const dirNames = (entries: { name: string; isDirectory: () => boolean }[], dir: string): string[] =>
  entries.filter((e) => e.isDirectory()).map((e) => path.join(dir, e.name));

/**
 * Walk the tree attaching a watcher to any directory not already covered.
 *
 * Descends unconditionally. Recursing only into newly-discovered directories misses
 * grandchildren created inside an already-watched directory, so every write beneath
 * them would be invisible to the change feed.
 */
async function attachBelow(crawl: Crawl, dir: string): Promise<void> {
  if (crawl.isClosed()) return;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    crawl.onError(err);
    return;
  }
  for (const child of dirNames(entries, dir)) {
    const isNew = !crawl.isWatched(child);
    crawl.watchDir(child);
    // Writes can land inside a directory between its creation and our attaching to it;
    // those events are gone. Firing on first attach makes the subtree observable.
    if (isNew && crawl.isWatched(child)) crawl.fire();
    await attachBelow(crawl, child);
  }
}

/**
 * The same walk, synchronous, for startup: no edit may slip through the gap between
 * `watchTree` returning and an async scan finishing.
 */
function attachBelowSync(crawl: Crawl, dir: string): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    crawl.onError(err);
    return;
  }
  for (const child of dirNames(entries, dir)) {
    crawl.watchDir(child);
    attachBelowSync(crawl, child);
  }
}
