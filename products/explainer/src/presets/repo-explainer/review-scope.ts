import { realpathSync } from "node:fs";
import { relative, resolve } from "node:path";
import { workingTreeSource, type CodeGraphStore, type IndexSource } from "@titan-design/code-graph";

/** The files the review read: the file nodes of the review index's newest snapshot, as repo-relative ids. */
export function reviewScopeFiles(store: CodeGraphStore): string[] {
  const [newest] = store.listSnapshots({ limit: 1 });
  if (newest === undefined) return [];
  return store
    .listNodes(newest.id)
    .filter((node) => node.kind === "file")
    .map((node) => node.id)
    .sort();
}

const SCRIPT_FILE = /\.[cm]?[jt]sx?$/;

// A hidden file is read through a path that is not there, so every layer sees the host's own not-found error.
const ABSENT = ".outside-review-scope";

/**
 * A working-tree source that sees only the scoped files. The index root stays the clone, because
 * `indexPaths` roots file ids at the first path when the clone is not a git toplevel, so the walk
 * still visits the whole clone and the list is cut down here. Unscoped scripts are also hidden from
 * the type checker, which would otherwise follow imports into a vendored tree and keep every file it opens.
 */
export function scopedSource(clonePath: string, files: readonly string[]): IndexSource {
  const base = workingTreeSource();
  // Outside git the walk keeps the clone path as written, so a symlinked tmpdir must match either spelling.
  const tops = [realpathSync(clonePath), resolve(clonePath)];
  const scoped = new Set(files);
  const unscoped = (abs: string): boolean => {
    const rel = tops.map((top) => relative(top, abs)).find((candidate) => !candidate.startsWith(".."));
    return rel !== undefined && !scoped.has(rel);
  };
  const hidden = (abs: string): boolean => unscoped(abs) && SCRIPT_FILE.test(abs);
  const seen = (path: string): string => (hidden(path) ? `${path}${ABSENT}` : path);
  const fileSystem = new Proxy(base.fileSystem, {
    get(target, key, receiver) {
      const member: unknown = Reflect.get(target, key, receiver);
      if (typeof member !== "function") return member;
      const bound = (...args: unknown[]): unknown => Reflect.apply(member, target, args);
      const readsFile = key === "fileExists" || key === "fileExistsSync" || key === "readFile" || key === "readFileSync";
      return readsFile ? (path: string, ...rest: unknown[]) => bound(seen(path), ...rest) : bound;
    },
  });
  return {
    ...base,
    fileSystem,
    fileExists: (abs) => base.fileExists(seen(abs)),
    readFile: (abs) => base.readFile(seen(abs)),
    listFiles: async (rootDirs, languages) => (await base.listFiles(rootDirs, languages)).filter((abs) => !unscoped(abs)),
  };
}
