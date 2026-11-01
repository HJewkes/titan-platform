// Sidecar for scripts/test-footprint.mjs (TP-4571). Files a test creates and deletes are gone by the time it ends, so
// only a watcher sees them, and it runs in its own process so its inotify callbacks do not bill a test worker. Paths
// count once each: a lock file re-created a thousand times is one path. Inotify events past the kernel's queue are lost
// without notice, so `created` is a floor.
import * as fs from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { fileDirOf } from "./test-footprint-core.mjs";

const FLUSH_MS = 15_000;
const RUN_ROOT = "(run root)";

class TreeTally {
  watchers = new Map();
  seen = new Set();
  tally = { byDir: {}, events: 0, watchFailures: 0 };

  constructor({ watch, lstat, readdir }) {
    Object.assign(this, { watch, lstat, readdir });
  }

  unwatch(dir) {
    this.watchers.get(dir)?.close();
    this.watchers.delete(dir);
  }

  count(path, isDir) {
    if (this.seen.has(path)) return;
    this.seen.add(path);
    const dir = fileDirOf(path);
    if (dir === basename(path)) return;
    const entry = (this.tally.byDir[dir ?? RUN_ROOT] ??= { files: 0, dirs: 0 });
    entry[isDir ? "dirs" : "files"] += 1;
  }

  scan(dir) {
    let entries = [];
    try {
      entries = this.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) this.note(join(dir, entry.name), entry.isDirectory());
  }

  addWatch(dir) {
    if (this.watchers.has(dir)) return;
    try {
      const watcher = this.watch(dir, (type, name) => type === "rename" && name && this.onRename(join(dir, name)));
      watcher.on("error", () => this.unwatch(dir));
      this.watchers.set(dir, watcher);
    } catch {
      this.tally.watchFailures += 1;
      return;
    }
    this.scan(dir);
  }

  note(path, isDir) {
    this.count(path, isDir);
    if (isDir) this.addWatch(path);
  }

  onRename(path) {
    this.tally.events += 1;
    let stat = null;
    try {
      stat = this.lstat(path);
    } catch {
      this.unwatch(path);
    }
    if (stat) this.note(path, stat.isDirectory());
    else this.count(path, false);
  }
}

/** Recursive tally over one fs.watch per directory; a new directory is scanned, since it fills before its watch lands. */
export function createTreeTally({ root, watch = fs.watch, lstat = fs.lstatSync, readdir = fs.readdirSync }) {
  const tree = new TreeTally({ watch, lstat, readdir });
  tree.addWatch(root);
  return { tally: tree.tally, close: () => [...tree.watchers.keys()].forEach((dir) => tree.unwatch(dir)) };
}

/** Top-level entries appearing in a shared flat dir, each with its time; the dir's own contents are not followed. */
export function createFlatLog({ dir, watch = fs.watch, lstat = fs.lstatSync, now = Date.now, uid = process.getuid() }) {
  const entries = [];
  const logged = new Set();
  const watcher = watch(dir, (type, name) => {
    if (type !== "rename" || !name || logged.has(name)) return;
    try {
      if (lstat(join(dir, name)).uid !== uid) return;
    } catch {
      return;
    }
    logged.add(name);
    entries.push({ name, atMs: now() });
  });
  return { entries, close: () => watcher.close() };
}

function main([outPath, treeRoot, flatRoot]) {
  const tree = createTreeTally({ root: treeRoot });
  const flat = createFlatLog({ dir: flatRoot });
  const parent = process.ppid;
  const flush = () => fs.writeFileSync(outPath, `${JSON.stringify({ ...tree.tally, tmp: flat.entries })}\n`);
  const stop = () => {
    flush();
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  setInterval(() => (process.ppid === parent ? flush() : stop()), FLUSH_MS);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
