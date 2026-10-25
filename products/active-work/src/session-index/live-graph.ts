import { statSync } from 'node:fs';
import { clearDocumentFrequency } from '../search/document-frequency.js';
import { startCheckpointer } from './checkpoint.js';
import { defaultGraphPath, openGraph, type WorkspaceGraph } from './graph.js';
import { withRefreshLock } from './refresh.js';

/**
 * The daemon's one long-lived graph handle, which follows the file at
 * `defaultGraphPath()` across a `miner rebuild` swap (TP-882).
 *
 * The swap renames a fresh file over the path while the daemon still holds the
 * old inode open. Every daemon write runs under the refresh lock, and so does
 * the swap, so checking the inode at the top of each locked section is enough:
 * the daemon can never write to the old file after the swap has finished.
 */
export interface LiveGraph {
  /** The graph at the path now, reopened if the path's inode moved. Call it holding the refresh lock. */
  current(): Promise<WorkspaceGraph>;
  close(): Promise<void>;
}

interface OpenHandle {
  graph: WorkspaceGraph;
  inode: bigint | null;
  stopCheckpointer(): Promise<void>;
}

interface LiveGraphOptions {
  path?: string;
  onCheckpointerError?: (err: unknown) => void;
}

function inodeAt(file: string): bigint | null {
  return statSync(file, { bigint: true, throwIfNoEntry: false })?.ino ?? null;
}

function openHandle(file: string, options: LiveGraphOptions): OpenHandle {
  const graph = openGraph(file);
  const checkpointer = startCheckpointer(graph.db, { onError: options.onCheckpointerError });
  return { graph, inode: inodeAt(file), stopCheckpointer: () => checkpointer.stop() };
}

async function closeHandle(handle: OpenHandle): Promise<void> {
  await handle.stopCheckpointer();
  handle.graph.db.close();
}

/** Opens at once, so a graph that cannot be opened fails the caller here rather than on its first pass. */
export function openLiveGraph(options: LiveGraphOptions = {}): LiveGraph {
  const file = options.path ?? defaultGraphPath();
  let handle: OpenHandle | null = openHandle(file, options);
  return {
    async current() {
      if (handle && handle.inode === inodeAt(file)) return handle.graph;
      // Close before opening: closing the last connection to the old inode
      // deletes `<path>-wal` and `<path>-shm` by name, which by now are the new
      // file's. Under the lock they hold no frame, so nothing is lost.
      if (handle) await closeHandle(handle);
      handle = null;
      clearDocumentFrequency(file);
      handle = openHandle(file, options);
      return handle.graph;
    },
    async close() {
      const closing = handle;
      handle = null;
      if (!closing) return;
      // A handle on a swapped-out inode deletes the new file's WAL and shm on
      // close, which a writer outside the daemon may be using: wait it out.
      if (closing.inode === inodeAt(file)) await closeHandle(closing);
      else await withRefreshLock(() => closeHandle(closing));
    },
  };
}
