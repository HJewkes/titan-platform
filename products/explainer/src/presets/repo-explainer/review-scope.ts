import { realpathSync } from "node:fs";
import { dirname, join, relative } from "node:path";
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

/** The fewest directories whose subtrees hold every scoped file: a dir is dropped once an ancestor is kept. */
export function scopeRoots(clonePath: string, files: readonly string[]): string[] {
  const dirs = [...new Set(files.map((file) => dirname(file)))].sort();
  const kept = dirs.filter((dir, i) => !dirs.slice(0, i).some((parent) => parent === "." || dir === parent || dir.startsWith(`${parent}/`)));
  return kept.map((dir) => join(clonePath, dir));
}

const SCRIPT_FILE = /\.[cm]?[jt]sx?$/;

// A hidden file is read through a path that is not there, so every layer sees the host's own not-found error.
const ABSENT = ".outside-review-scope";

/**
 * A working-tree source that sees only the scoped script files. The roots stay directories (the walker
 * recurses), so a scoped dir that also holds vendored siblings would otherwise index them too, and the
 * type checker would otherwise follow imports into the vendored tree and keep every file it opens.
 */
export function scopedSource(clonePath: string, files: readonly string[]): IndexSource {
  const base = workingTreeSource();
  const top = realpathSync(clonePath);
  const scoped = new Set(files);
  const hidden = (abs: string): boolean => {
    const rel = relative(top, abs);
    return !rel.startsWith("..") && SCRIPT_FILE.test(rel) && !scoped.has(rel);
  };
  const seen = (path: string): string => (hidden(path) ? `${path}${ABSENT}` : path);
  const fileSystem = new Proxy(base.fileSystem, {
    get(target, key, receiver) {
      const member = Reflect.get(target, key, receiver) as unknown;
      if (typeof member !== "function") return member;
      const bound = member.bind(target) as (path: unknown, ...rest: unknown[]) => unknown;
      const readsFile = key === "fileExists" || key === "fileExistsSync" || key === "readFile" || key === "readFileSync";
      return readsFile ? (path: string, ...rest: unknown[]) => bound(seen(path), ...rest) : bound;
    },
  });
  return {
    ...base,
    fileSystem,
    fileExists: (abs) => base.fileExists(seen(abs)),
    readFile: (abs) => base.readFile(seen(abs)),
    listFiles: async (rootDirs, languages) => (await base.listFiles(rootDirs, languages)).filter((abs) => !hidden(abs)),
  };
}
