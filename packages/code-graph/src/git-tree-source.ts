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

/**
 * Where `abs` really points: its longest existing prefix resolved through
 * realpath, the missing rest appended. A dangling link (a package dir deleted
 * since the commit, say) is followed through its target so it still lands in the repo.
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
 * Where a path's answer comes from, decided by where it really points, not by
 * how it is spelled: a workspace link under node_modules into a tracked package
 * lands in the repo and answers from the commit. Tracked paths come from the
 * commit; untracked build output (a gitignored dist/) and out-of-repo paths come
 * from disk, as a checkout would see them; any other in-repo path is absent.
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
    const canonical = this.canonicalOf(abs);
    const rel = path.relative(this.root, canonical);
    if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      return { origin: "disk", canonical, rel: null };
    }
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

  private canonicalOf(abs: string): string {
    let canonical = this.canonical.get(abs);
    if (canonical === undefined) {
      canonical = canonicalize(abs);
      this.canonical.set(abs, canonical);
    }
    return canonical;
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
  return {
    fileExists: (abs) => {
      const at = tree.locate(abs, "file");
      return at.origin === "tree" || (at.origin === "disk" && real.fileExistsSync(at.canonical));
    },
    readFile: (abs) => {
      const at = tree.locate(abs, "file");
      if (at.origin === "tree") return tree.read(at.rel!);
      return at.origin === "disk" ? real.readFileSync(at.canonical, "utf-8") : missing(abs, "file");
    },
    directoryExists: (abs) => {
      const at = tree.locate(abs, "dir");
      return at.origin === "tree" || (at.origin === "disk" && real.directoryExistsSync(at.canonical));
    },
    readDir: (abs) => readDirAt(tree, real, abs),
    realpath: (abs) => tree.locate(abs, "file").canonical,
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
 * Roots for indexing a revision: ids are rooted at the realpath'd repo root, and
 * each indexed dir is canonicalized even when the working tree no longer has it.
 */
export function rootsAtRevision(
  paths: readonly string[],
  revision: NonNullable<IndexSource["revision"]>,
): { rootDirs: string[]; idRoot: string } {
  return { rootDirs: paths.map((p) => canonicalize(p)), idRoot: realpathSync(revision.repoRoot) };
}
