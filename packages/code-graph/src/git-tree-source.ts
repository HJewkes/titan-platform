import { existsSync, readFileSync, realpathSync } from "node:fs";
import * as path from "node:path";
import { isExcludedDir, shouldIncludeFile } from "@titan-design/code-parser";
import { Project, type FileSystemHost, type RuntimeDirEntry } from "ts-morph";
import { detectGitToplevel } from "./history/git.js";
import { listTreeBlobs, readBlobs, resolveCommit } from "./history/git-tree.js";
import { workingTreeSource, type IndexSource } from "./index-source.js";

// Everything the indexer, ts-morph or generated.ts may read in the repo; batched into one cat-file.
const READ_BY_INDEX = /\.(?:[cm]?[jt]sx?|json|pyi?)$|(?:^|\/)\.gitattributes$/;

let emptyHost: FileSystemHost | undefined;

/**
 * ts-morph only treats its own `errors.FileNotFoundError` / `DirectoryNotFoundError`
 * as "absent", and does not export them; an empty in-memory host throws them for any path.
 */
function missing(abs: string, kind: "file" | "dir"): never {
  emptyHost ??= new Project({ useInMemoryFileSystem: true }).getFileSystem();
  if (kind === "file") emptyHost.readFileSync(abs);
  else emptyHost.readDirSync(abs);
  throw new Error(`${abs} was expected to be missing`);
}

/** Whether `rel` sits in a dir the walk never ingests (dist, build, node_modules, …). */
function inBuildOutput(rel: string, includeSelf: boolean): boolean {
  const segments = rel.split(path.sep);
  return (includeSelf ? segments : segments.slice(0, -1)).some(isExcludedDir);
}

/**
 * Where an answer about a path comes from. Tracked files come from the commit.
 * Out-of-repo paths and untracked build output (gitignored dist/, node_modules)
 * come from disk, which is what a checkout of the commit would see there too.
 * Any other in-repo path is absent at the commit, whatever the working tree holds.
 */
type Origin = "tree" | "disk" | "missing";

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
    commit: string,
  ) {
    for (const blob of listTreeBlobs(this.root, commit)) this.addFile(blob.path.split("/").join(path.sep), blob.oid);
  }

  get root(): string {
    return this.roots[0]!;
  }

  /** The repo-relative path, or null for out-of-repo paths. */
  relative(abs: string): string | null {
    for (const root of this.roots) {
      const rel = path.relative(root, path.resolve(abs));
      if (!rel.startsWith("..") && !path.isAbsolute(rel)) return rel;
    }
    return null;
  }

  fileOrigin(abs: string): Origin {
    const rel = this.relative(abs);
    if (rel === null) return "disk";
    if (this.oids.has(rel)) return "tree";
    return inBuildOutput(rel, false) ? "disk" : "missing";
  }

  *files(): Generator<string> {
    for (const rel of this.oids.keys()) yield path.join(this.root, rel);
  }

  /** Children of a tracked dir, or undefined when the commit has no such dir. */
  children(rel: string): Map<string, boolean> | undefined {
    return this.dirs.get(rel);
  }

  /** In-tree paths are never symlinks, so the canonical path is the canonical root plus the relative path. */
  realpath(rel: string): string {
    return path.join(this.root, rel);
  }

  read(abs: string): string {
    const oid = this.oids.get(this.relative(abs) ?? "");
    if (oid === undefined) return missing(abs, "file");
    this.contents ??= readBlobs(this.root, [...this.oids].filter(([rel]) => READ_BY_INDEX.test(rel)).map(([, o]) => o));
    // A blob outside READ_BY_INDEX is rare enough to read on its own.
    if (!this.contents.has(oid)) this.contents.set(oid, readBlobs(this.root, [oid]).get(oid)!);
    return this.contents.get(oid)!;
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

/** Build-output entries on disk under an in-repo dir: all of them inside build output, else only build-output dirs. */
function diskBuildEntries(real: FileSystemHost, abs: string, rel: string): RuntimeDirEntry[] {
  if (!real.directoryExistsSync(abs)) return [];
  const entries = real.readDirSync(abs);
  if (inBuildOutput(rel, true)) return entries;
  return entries.filter((e) => e.isDirectory && isExcludedDir(path.basename(e.name)));
}

/** A dir's entries: the commit's, plus untracked build output on disk; directoryExists agrees with it. */
function readInRepoDir(tree: CommitTree, real: FileSystemHost, abs: string, rel: string): RuntimeDirEntry[] {
  const tracked = tree.children(rel);
  const fromDisk = diskBuildEntries(real, abs, rel);
  if (!tracked && fromDisk.length === 0) return missing(abs, "dir");
  const entries = new Map<string, RuntimeDirEntry>();
  for (const [name, isDirectory] of tracked ?? []) {
    entries.set(name, { name: path.join(path.resolve(abs), name), isFile: !isDirectory, isDirectory, isSymlink: false });
  }
  for (const entry of fromDisk) if (!entries.has(path.basename(entry.name))) entries.set(path.basename(entry.name), entry);
  return [...entries.values()];
}

function directoryExistsIn(tree: CommitTree, real: FileSystemHost, abs: string): boolean {
  const rel = tree.relative(abs);
  if (rel === null) return real.directoryExistsSync(abs);
  if (tree.children(rel)) return true;
  return path.basename(rel) !== "" && inBuildOutput(rel, true) && real.directoryExistsSync(abs);
}

/** Symlinks live on disk (node_modules, build output); the commit's own paths resolve to the canonical root. */
function realpathIn(tree: CommitTree, real: FileSystemHost, abs: string): string {
  const rel = tree.relative(abs);
  return rel === null || inBuildOutput(rel, true) ? real.realpathSync(abs) : tree.realpath(rel);
}

/** Every answer routes through {@link CommitTree.fileOrigin}, so existence, reads and listings agree. */
function overlayHost(tree: CommitTree, real: FileSystemHost): FileSystemHost {
  const fileExistsSync = (p: string) => {
    const origin = tree.fileOrigin(p);
    return origin === "tree" || (origin === "disk" && real.fileExistsSync(p));
  };
  const readFileSync = (p: string, encoding?: string) => {
    const origin = tree.fileOrigin(p);
    return origin === "disk" ? real.readFileSync(p, encoding) : tree.read(p);
  };
  const directoryExistsSync = (p: string) => directoryExistsIn(tree, real, p);
  return {
    isCaseSensitive: () => real.isCaseSensitive(),
    readDirSync: (p) => {
      const rel = tree.relative(p);
      return rel === null ? real.readDirSync(p) : readInRepoDir(tree, real, p, rel);
    },
    readFileSync,
    readFile: async (p, encoding) => readFileSync(p, encoding),
    fileExistsSync,
    fileExists: async (p) => fileExistsSync(p),
    directoryExistsSync,
    directoryExists: async (p) => directoryExistsSync(p),
    realpathSync: (p) => realpathIn(tree, real, p),
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
 * match a working-tree index of the same commit. Imports into node_modules, and
 * untracked build output such as a gitignored dist/, resolve against today's disk.
 */
export function gitTreeSource(repoRoot: string, rev: string): IndexSource {
  const canonicalRoot = canonicalToplevel(repoRoot);
  const { commit, commitEpoch } = resolveCommit(canonicalRoot, rev);
  const tree = new CommitTree(rootSpellings(repoRoot, canonicalRoot), commit);
  const disk = workingTreeSource();
  let fileSystem: FileSystemHost | undefined;
  return {
    listFiles: async (rootDirs, languages) => listTreeFiles(tree, rootDirs, languages),
    readFile: (abs) => (tree.fileOrigin(abs) === "disk" ? readFileSync(abs, "utf-8") : tree.read(abs)),
    fileExists: (abs) => {
      const origin = tree.fileOrigin(abs);
      return origin === "tree" || (origin === "disk" && existsSync(abs));
    },
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
