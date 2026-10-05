import { readlinkSync, realpathSync } from "node:fs";
import * as path from "node:path";
import { isExcludedDir, shouldIncludeFile } from "@titan-design/code-parser";
import { Project, type FileSystemHost, type RuntimeDirEntry } from "ts-morph";
import { detectGitToplevel } from "./history/git.js";
import { listTreeBlobs, readBlobs, resolveCommit } from "./history/git-tree.js";
import { workingTreeSource, type IndexSource } from "./index-source.js";

// Everything the indexer, ts-morph or generated.ts may read in the repo; batched into one cat-file.
const READ_BY_INDEX = /\.(?:[cm]?[jt]sx?|json|pyi?)$|(?:^|\/)\.gitattributes$/;
// Matches the kernel's SYMLOOP_MAX: a longer chain of dangling links is a cycle.
const MAX_LINK_HOPS = 40;

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

function linkTarget(abs: string): string | null {
  try {
    return path.resolve(path.dirname(abs), readlinkSync(abs));
  } catch {
    return null;
  }
}

/** `abs` relative to `root`, or null when it lies outside it; a name such as `..foo` is inside. */
function relativeInside(root: string, abs: string): string | null {
  const rel = path.relative(root, abs);
  return rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel) ? null : rel;
}

/**
 * `abs` with its longest existing prefix resolved through realpath and the
 * missing rest appended, following dangling links. Only for paths outside the repo.
 */
function canonicalize(abs: string, hops = 0): string {
  const rest: string[] = [];
  for (let at = path.resolve(abs); ; at = path.dirname(at)) {
    try {
      return path.join(realpathSync(at), ...rest.reverse());
    } catch {
      const target = hops < MAX_LINK_HOPS ? linkTarget(at) : null;
      if (target !== null) return canonicalize(path.join(target, ...rest.reverse()), hops + 1);
      if (path.dirname(at) === at) return path.resolve(abs);
      rest.push(path.basename(at));
    }
  }
}

/** Whether `rel` sits in a dir the walk never ingests (dist, build, node_modules, …). */
function inBuildOutput(rel: string, includeSelf: boolean): boolean {
  const segments = rel.split(path.sep);
  return (includeSelf ? segments : segments.slice(0, -1)).some(isExcludedDir);
}

/**
 * Where a path's answer comes from. The path is resolved one component at a
 * time, as a checkout of the commit would resolve it: a component the commit
 * tracks is the commit's plain file or dir, whatever today's disk has there;
 * any other component is looked up on disk, following symlinks, so a workspace
 * link under node_modules lands in the tracked package it points at. Tracked
 * paths come from the commit; untracked build output (a gitignored dist/) and
 * out-of-repo paths come from disk; any other in-repo path is absent.
 */
interface Location {
  origin: "tree" | "disk" | "missing";
  canonical: string;
  /** Repo-relative path of `canonical`; null outside the repo. */
  rel: string | null;
}

/** A commit's files keyed by repo-relative path, content read once on first use. */
class CommitTree {
  private readonly oids = new Map<string, string>();
  private readonly dirs = new Map<string, Map<string, boolean>>();
  private readonly canonical = new Map<string, string>();
  private contents: Map<string, string> | undefined;

  constructor(
    readonly root: string,
    commit: string,
  ) {
    for (const blob of listTreeBlobs(root, commit)) this.addFile(blob.path.split("/").join(path.sep), blob.oid);
  }

  /** The one place an answer's origin is decided; every file, dir and realpath answer goes through it. */
  locate(abs: string, kind: "file" | "dir"): Location {
    const canonical = this.resolve(path.resolve(abs), 0);
    const rel = relativeInside(this.root, canonical);
    if (rel === null) return { origin: "disk", canonical, rel: null };
    const tracked = kind === "file" ? this.oids.has(rel) : this.dirs.has(rel);
    if (tracked) return { origin: "tree", canonical, rel };
    return { origin: inBuildOutput(rel, kind === "dir") ? "disk" : "missing", canonical, rel };
  }

  *files(): Generator<string> {
    for (const rel of this.oids.keys()) yield path.join(this.root, rel);
  }

  /** Children of a tracked dir (name to is-directory), or undefined when the commit has no such dir. */
  children(rel: string): Map<string, boolean> | undefined {
    return this.dirs.get(rel);
  }

  read(rel: string): string {
    const oid = this.oids.get(rel)!;
    this.contents ??= readBlobs(this.root, [...this.oids].filter(([r]) => READ_BY_INDEX.test(r)).map(([, o]) => o));
    // A blob outside READ_BY_INDEX is rare enough to read on its own.
    if (!this.contents.has(oid)) this.contents.set(oid, readBlobs(this.root, [oid]).get(oid)!);
    return this.contents.get(oid)!;
  }

  private tracks(abs: string): boolean {
    const rel = relativeInside(this.root, abs);
    return rel !== null && (this.oids.has(rel) || this.dirs.has(rel));
  }

  /** Memoized per path, so each dir's components are resolved once. */
  private resolve(abs: string, hops: number): string {
    let resolved = this.canonical.get(abs);
    if (resolved === undefined) {
      const parent = path.dirname(abs);
      resolved = parent === abs ? abs : this.step(this.resolve(parent, hops), path.basename(abs), hops);
      this.canonical.set(abs, resolved);
    }
    return resolved;
  }

  private step(dir: string, name: string, hops: number): string {
    const next = path.join(dir, name);
    if (this.tracks(next)) return next;
    const target = hops < MAX_LINK_HOPS ? linkTarget(next) : null;
    return target === null ? next : this.resolve(target, hops + 1);
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
    const rel = relativeInside(rootDir, abs);
    if (rel === null) continue;
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

/** One answer per path, shared by the IndexSource methods and the ts-morph host so they always agree. */
interface TreeAnswers {
  fileExists(abs: string): boolean;
  readFile(abs: string): string;
  directoryExists(abs: string): boolean;
  readDir(abs: string): RuntimeDirEntry[];
  realpath(abs: string): string;
}

/** Untracked build-output dirs on disk under a tracked dir, so a listing agrees with directoryExists. */
function diskBuildDirs(real: FileSystemHost, canonical: string): RuntimeDirEntry[] {
  if (!real.directoryExistsSync(canonical)) return [];
  return real.readDirSync(canonical).filter((e) => e.isDirectory && isExcludedDir(path.basename(e.name)));
}

/** Entries are named under the path as asked, as the real host names them. */
function readDirAt(tree: CommitTree, real: FileSystemHost, abs: string): RuntimeDirEntry[] {
  const at = tree.locate(abs, "dir");
  const asAsked = (entry: RuntimeDirEntry) => ({ ...entry, name: path.join(path.resolve(abs), path.basename(entry.name)) });
  if (at.origin === "missing") return missing(abs, "dir");
  if (at.origin === "disk") return real.readDirSync(at.canonical).map(asAsked);
  const entries = new Map<string, RuntimeDirEntry>();
  for (const [name, isDirectory] of tree.children(at.rel!)!) {
    entries.set(name, asAsked({ name, isFile: !isDirectory, isDirectory, isSymlink: false }));
  }
  for (const entry of diskBuildDirs(real, at.canonical)) {
    const name = path.basename(entry.name);
    if (!entries.has(name)) entries.set(name, asAsked(entry));
  }
  return [...entries.values()];
}

function treeAnswers(tree: CommitTree, real: FileSystemHost): TreeAnswers {
  const fileExists = (abs: string) => {
    const at = tree.locate(abs, "file");
    return at.origin === "tree" || (at.origin === "disk" && real.fileExistsSync(at.canonical));
  };
  const directoryExists = (abs: string) => {
    const at = tree.locate(abs, "dir");
    return at.origin === "tree" || (at.origin === "disk" && real.directoryExistsSync(at.canonical));
  };
  return {
    fileExists,
    readFile: (abs) => {
      const at = tree.locate(abs, "file");
      if (at.origin === "tree") return tree.read(at.rel!);
      return at.origin === "disk" ? real.readFileSync(at.canonical, "utf-8") : missing(abs, "file");
    },
    directoryExists,
    readDir: (abs) => readDirAt(tree, real, abs),
    // Like the real host, realpath of an absent path throws.
    realpath: (abs) =>
      fileExists(abs) || directoryExists(abs) ? tree.locate(abs, "file").canonical : missing(abs, "file"),
  };
}

function overlayHost(answers: TreeAnswers, real: FileSystemHost): FileSystemHost {
  return {
    isCaseSensitive: () => real.isCaseSensitive(),
    readDirSync: answers.readDir,
    readFileSync: (p) => answers.readFile(p),
    readFile: async (p) => answers.readFile(p),
    fileExistsSync: answers.fileExists,
    fileExists: async (p) => answers.fileExists(p),
    directoryExistsSync: answers.directoryExists,
    directoryExists: async (p) => answers.directoryExists(p),
    realpathSync: answers.realpath,
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

/**
 * Index `rev`'s tree from git objects, without a checkout and without writing to
 * the repo. Files keep their `<repo root>/<tree path>` absolute paths, so ids
 * match a working-tree index of the same commit. Workspace links into the repo
 * resolve to the commit; installed packages and untracked build output such as
 * a gitignored dist/ resolve against today's disk.
 */
export function gitTreeSource(repoRoot: string, rev: string): IndexSource {
  const canonicalRoot = canonicalToplevel(repoRoot);
  const { commit, commitEpoch } = resolveCommit(canonicalRoot, rev);
  const tree = new CommitTree(canonicalRoot, commit);
  const real = workingTreeSource().fileSystem;
  const answers = treeAnswers(tree, real);
  let fileSystem: FileSystemHost | undefined;
  return {
    listFiles: async (rootDirs, languages) => listTreeFiles(tree, rootDirs, languages),
    readFile: answers.readFile,
    // Like `existsSync` in the working-tree source, true for a dir as well as a file.
    fileExists: (abs) => answers.fileExists(abs) || answers.directoryExists(abs),
    get fileSystem() {
      fileSystem ??= overlayHost(answers, real);
      return fileSystem;
    },
    revision: { repoRoot: canonicalRoot, commit, commitEpoch },
  };
}

/**
 * An indexed dir in repo coordinates: the nearest ancestor that realpaths to the
 * repo root is rebased onto it and the rest kept as spelled, so a dir the commit
 * tracks is never resolved through today's symlinks or found missing on disk.
 */
function rebaseOntoRoot(abs: string, repoRoot: string): string {
  const rest: string[] = [];
  for (let at = path.resolve(abs); path.dirname(at) !== at; at = path.dirname(at)) {
    if (realpathOrNull(at) === repoRoot) return path.join(repoRoot, ...rest.reverse());
    rest.push(path.basename(at));
  }
  return canonicalize(abs);
}

function realpathOrNull(abs: string): string | null {
  try {
    return realpathSync(abs);
  } catch {
    return null;
  }
}

/** Roots for indexing a revision: ids are rooted at the realpath'd repo root, and so is each indexed dir. */
export function rootsAtRevision(
  paths: readonly string[],
  revision: NonNullable<IndexSource["revision"]>,
): { rootDirs: string[]; idRoot: string } {
  const idRoot = realpathSync(revision.repoRoot);
  return { rootDirs: paths.map((p) => rebaseOntoRoot(p, idRoot)), idRoot };
}
