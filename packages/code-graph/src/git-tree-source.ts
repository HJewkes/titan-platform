import { existsSync, readFileSync, realpathSync } from "node:fs";
import * as path from "node:path";
import { isExcludedDir, shouldIncludeFile } from "@titan-design/code-parser";
import type { FileSystemHost, RuntimeDirEntry } from "ts-morph";
import { detectGitToplevel } from "./history/git.js";
import { listTreeBlobs, readBlobs, resolveCommit } from "./history/git-tree.js";
import { workingTreeSource, type IndexSource } from "./index-source.js";

// Everything the indexer, ts-morph or generated.ts may read in the repo; batched into one cat-file.
const READ_BY_INDEX = /\.(?:[cm]?[jt]sx?|json|pyi?)$|(?:^|\/)\.gitattributes$/;

function notFound(abs: string): Error {
  return Object.assign(new Error(`ENOENT: ${abs} is not in the git tree`), { code: "ENOENT" });
}

/**
 * A commit's files keyed by repo-relative path, content read once on first use.
 * `roots` are the spellings of the repo root (canonical first), so a path under
 * a symlinked alias such as `/var` on macOS still answers from the tree.
 */
class CommitTree {
  private readonly oids = new Map<string, string>();
  private readonly dirs = new Map<string, Map<string, boolean>>();
  private contents: Map<string, string> | undefined;

  constructor(
    private readonly roots: readonly string[],
    private readonly commit: string,
  ) {
    for (const blob of listTreeBlobs(this.root, commit)) this.addFile(blob.path.split("/").join(path.sep), blob.oid);
  }

  get root(): string {
    return this.roots[0]!;
  }

  /** The repo-relative path the tree answers for, or null for node_modules and out-of-repo paths. */
  relative(abs: string): string | null {
    for (const root of this.roots) {
      const rel = path.relative(root, path.resolve(abs));
      if (rel.startsWith("..") || path.isAbsolute(rel)) continue;
      return rel.split(path.sep).includes("node_modules") ? null : rel;
    }
    return null;
  }

  owns(abs: string): boolean {
    return this.relative(abs) !== null;
  }

  *files(): Generator<string> {
    for (const rel of this.oids.keys()) yield path.join(this.root, rel);
  }

  hasFile(abs: string): boolean {
    return this.oids.has(this.relative(abs) ?? "");
  }

  hasDir(abs: string): boolean {
    const rel = this.relative(abs);
    return rel !== null && this.dirs.has(rel);
  }

  /** In-tree paths are never symlinks, so the canonical path is the canonical root plus the relative path. */
  realpath(abs: string): string {
    return path.join(this.root, this.relative(abs) ?? "");
  }

  read(abs: string): string {
    const oid = this.oids.get(this.relative(abs) ?? "");
    if (oid === undefined) throw notFound(abs);
    this.contents ??= this.readAll();
    const content = this.contents.get(oid);
    if (content === undefined) throw new Error(`${abs} is not a file the index reads from ${this.commit}`);
    return content;
  }

  readDir(abs: string): RuntimeDirEntry[] {
    const rel = this.relative(abs);
    const children = rel === null ? undefined : this.dirs.get(rel);
    if (!children) throw notFound(abs);
    return [...children].map(([name, isDirectory]) => ({
      name: path.join(path.resolve(abs), name),
      isFile: !isDirectory,
      isDirectory,
      isSymlink: false,
    }));
  }

  private readAll(): Map<string, string> {
    const wanted = [...this.oids].filter(([rel]) => READ_BY_INDEX.test(rel)).map(([, oid]) => oid);
    return readBlobs(this.root, wanted);
  }

  private addFile(rel: string, oid: string): void {
    this.oids.set(rel, oid);
    let child = rel;
    let isDirectory = false;
    for (let dir = path.dirname(rel); child !== "."; child = dir, dir = path.dirname(dir)) {
      const key = dir === "." ? "" : dir;
      const known = this.dirs.has(key);
      const children = this.dirs.get(key) ?? new Map<string, boolean>();
      children.set(path.basename(child), isDirectory);
      this.dirs.set(key, children);
      if (known) return;
      isDirectory = true;
    }
  }
}

/** The tree's files under `rootDir` that `walkSourceFiles` would ingest from a checkout. */
function* ingestedUnder(tree: CommitTree, rootDir: string, languages: readonly string[]): Generator<string> {
  for (const abs of tree.files()) {
    const rel = path.relative(rootDir, abs);
    if (rel.startsWith("..") || path.isAbsolute(rel)) continue;
    if (path.dirname(rel).split(path.sep).some(isExcludedDir)) continue;
    if (shouldIncludeFile(rel, [...languages])) yield abs;
  }
}

function listTreeFiles(tree: CommitTree, rootDirs: readonly string[], languages: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const rootDir of rootDirs) {
    for (const abs of ingestedUnder(tree, rootDir, languages)) seen.add(abs);
  }
  return [...seen];
}

function readOnly(): never {
  throw new Error("a git tree source is read-only");
}

/** The tree in the repo, the real host for node_modules and out-of-repo paths. */
function overlayHost(tree: CommitTree, real: FileSystemHost): FileSystemHost {
  const fileExistsSync = (p: string) => (tree.owns(p) ? tree.hasFile(p) : real.fileExistsSync(p));
  const directoryExistsSync = (p: string) => (tree.owns(p) ? tree.hasDir(p) : real.directoryExistsSync(p));
  const readFileSync = (p: string, encoding?: string) => (tree.owns(p) ? tree.read(p) : real.readFileSync(p, encoding));
  return {
    isCaseSensitive: () => real.isCaseSensitive(),
    readDirSync: (p) => (tree.owns(p) ? tree.readDir(p) : real.readDirSync(p)),
    readFileSync,
    readFile: async (p, encoding) => readFileSync(p, encoding),
    fileExistsSync,
    fileExists: async (p) => fileExistsSync(p),
    directoryExistsSync,
    directoryExists: async (p) => directoryExistsSync(p),
    realpathSync: (p) => (tree.owns(p) ? tree.realpath(p) : real.realpathSync(p)),
    getCurrentDirectory: () => real.getCurrentDirectory(),
    glob: () => Promise.reject(new Error("glob is not supported on a git tree source")),
    globSync: () => readOnly(),
    delete: async () => readOnly(),
    deleteSync: readOnly,
    writeFile: async () => readOnly(),
    writeFileSync: readOnly,
    mkdir: async () => readOnly(),
    mkdirSync: readOnly,
    move: async () => readOnly(),
    moveSync: readOnly,
    copy: async () => readOnly(),
    copySync: readOnly,
  };
}

function canonicalToplevel(repoRoot: string): string {
  const toplevel = detectGitToplevel(path.resolve(repoRoot));
  if (toplevel === null) throw new Error(`${repoRoot} is not inside a git repository`);
  return realpathSync(toplevel);
}

/** The canonical root, plus the root as the caller spelled it when that goes through a symlink. */
function rootSpellings(repoRoot: string, canonicalRoot: string): string[] {
  const given = path.resolve(repoRoot);
  const asGiven = path.resolve(given, path.relative(realpathSync(given), canonicalRoot));
  return [...new Set([canonicalRoot, asGiven])];
}

/**
 * Index `rev`'s tree from git objects, without a checkout and without writing to
 * the repo. Files keep their `<repo root>/<tree path>` absolute paths, so ids
 * match a working-tree index of the same commit. Imports into node_modules
 * resolve against today's install on disk.
 */
export function gitTreeSource(repoRoot: string, rev: string): IndexSource {
  const canonicalRoot = canonicalToplevel(repoRoot);
  const { commit, commitEpoch } = resolveCommit(canonicalRoot, rev);
  const tree = new CommitTree(rootSpellings(repoRoot, canonicalRoot), commit);
  const disk = workingTreeSource();
  let fileSystem: FileSystemHost | undefined;
  return {
    listFiles: async (rootDirs, languages) => listTreeFiles(tree, rootDirs, languages),
    readFile: (abs) => (tree.owns(abs) ? tree.read(abs) : readFileSync(abs, "utf-8")),
    fileExists: (abs) => (tree.owns(abs) ? tree.hasFile(abs) : existsSync(abs)),
    get fileSystem() {
      fileSystem ??= overlayHost(tree, disk.fileSystem);
      return fileSystem;
    },
    revision: { repoRoot: canonicalRoot, commit, commitEpoch },
  };
}

/** The longest existing prefix of `abs` resolved through realpath, the missing rest appended. */
function canonicalizeMissing(abs: string): string {
  const missing: string[] = [];
  for (let dir = abs; ; dir = path.dirname(dir)) {
    try {
      return path.join(realpathSync(dir), ...missing.reverse());
    } catch {
      if (path.dirname(dir) === dir) return abs;
      missing.push(path.basename(dir));
    }
  }
}

/**
 * Roots for indexing a revision: ids are rooted at the realpath'd repo root, and
 * each indexed dir is canonicalized even when the working tree no longer has it.
 */
export function rootsAtRevision(
  paths: readonly string[],
  revision: NonNullable<IndexSource["revision"]>,
): { rootDirs: string[]; idRoot: string } {
  return { rootDirs: paths.map(canonicalizeMissing), idRoot: realpathSync(revision.repoRoot) };
}
