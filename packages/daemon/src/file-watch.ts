/**
 * Recursive filesystem watcher.
 *
 * Node's `fs.watch(dir, { recursive: true })` is only reliable on macOS and Windows; on
 * Linux recursive support is version-dependent. To stay portable we build the recursion
 * ourselves: watch the root plus every current subdirectory, and re-scan (adding watchers
 * for freshly-created dirs) whenever a change lands. Change events are debounced into a
 * single callback so a burst of atomic writes (temp file + rename) collapses into one.
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
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const watchers = new Map<string, FSWatcher>();
  const attachWaiters = new Map<string, Set<() => void>>();
  let debounceTimer: NodeJS.Timeout | null = null;
  let rescanTimer: NodeJS.Timeout | null = null;
  let closed = false;

  const fire = (): void => {
    if (closed) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      if (!closed) onChange();
    }, debounceMs);
  };

  /**
   * Whether writes under `dir` reach the change feed. Per-directory when we attach
   * per directory; under a recursive root watch every existing path beneath it is
   * covered, with no handle of its own to look up.
   */
  const covered = (dir: string): boolean => {
    if (closed) return false;
    if (watchers.has(dir)) return true;
    if (!RECURSIVE_WATCH) return false;
    const rel = path.relative(root, dir);
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel) && existsSync(dir);
  };

  const notifyAttached = (dir: string): void => {
    const waiters = attachWaiters.get(dir);
    if (!waiters) return;
    attachWaiters.delete(dir);
    for (const resolve of waiters) resolve();
  };

  /** Under a recursive watch nothing "attaches", so coverage is rechecked on each event. */
  const notifyNowCovered = (): void => {
    for (const dir of [...attachWaiters.keys()]) if (covered(dir)) notifyAttached(dir);
  };

  const scheduleRescan = (): void => {
    if (closed || rescanTimer) return;
    rescanTimer = setTimeout(() => {
      rescanTimer = null;
      void addNewDirs(root);
    }, debounceMs);
  };

  const watchDir = (dir: string, recursive = false): void => {
    if (closed || watchers.has(dir)) return;
    let w: FSWatcher;
    try {
      w = watch(dir, { persistent: false, recursive });
    } catch (err) {
      options.onError?.(err);
      return;
    }
    w.on("error", (err) => options.onError?.(err));
    w.on("change", () => {
      fire();
      // A new subdirectory may have appeared. One recursive handle already covers
      // it, so only the per-directory mode has to go attach to it.
      if (recursive) notifyNowCovered();
      else scheduleRescan();
    });
    watchers.set(dir, w);
    notifyAttached(dir);
  };

  const crawl: Crawl = {
    isClosed: () => closed,
    isWatched: (dir) => watchers.has(dir),
    watchDir: (dir) => watchDir(dir),
    fire,
    onError: (err) => options.onError?.(err),
  };
  const addNewDirs = (dir: string): Promise<void> => attachBelow(crawl, dir);

  const whenWatching = (dir: string, timeoutMs = DEFAULT_ATTACH_TIMEOUT_MS): Promise<boolean> => {
    if (covered(dir)) return Promise.resolve(true);
    if (closed) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        attachWaiters.get(dir)?.delete(done);
        resolve(covered(dir));
      };
      const timer = setTimeout(done, timeoutMs);
      timer.unref?.();
      const waiters = attachWaiters.get(dir) ?? new Set<() => void>();
      waiters.add(done);
      attachWaiters.set(dir, waiters);
    });
  };

  watchDir(root, RECURSIVE_WATCH);
  if (!RECURSIVE_WATCH) attachBelowSync(crawl, root);

  return {
    isWatching: covered,
    whenWatching,
    close(): void {
      closed = true;
      if (debounceTimer) clearTimeout(debounceTimer);
      if (rescanTimer) clearTimeout(rescanTimer);
      for (const w of watchers.values()) w.close();
      watchers.clear();
      for (const waiters of attachWaiters.values()) for (const resolve of waiters) resolve();
      attachWaiters.clear();
    },
  };
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
