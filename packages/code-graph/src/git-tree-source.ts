import { readlinkSync, realpathSync, statSync } from "node:fs";
import * as path from "node:path";
import { isExcludedDir, shouldIncludeFile } from "@titan-design/code-parser";
import { Project, type FileSystemHost, type RuntimeDirEntry } from "ts-morph";
import { detectGitToplevel } from "./history/git.js";
import { listTreeBlobs, readBlobs, resolveCommit } from "./history/git-tree.js";
import { overlayHost, type TreeAnswers } from "./git-tree-host.js";
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

/** Index of the first segment of `rel` naming a dir the walk never ingests (dist, build, node_modules, …), or -1. */
function firstExcluded(rel: string, includeSelf: boolean): number {
  const segments = rel.split(path.sep);
  return (includeSelf ? segments : segments.slice(0, -1)).findIndex(isExcludedDir);
}

type EntryKind = "file" | "dir" | "link";

/**
 * Where a path's answer comes from. The path is resolved one component at a
 * time, as a checkout of the commit would resolve it: a component the commit
 * tracks is the commit's file, dir or symlink, whatever today's disk has there,
 * and a tracked symlink is followed through the target its blob records; any
 * other component is looked up on disk, following symlinks, so a workspace
 * link under node_modules lands in the tracked package it points at. Tracked
 * paths come from the commit; untracked build output beneath a tracked dir (a
 * gitignored dist/) and out-of-repo paths come from disk; any other in-repo path is absent.
 */
interface Location {
  origin: "tree" | "disk" | "missing";
  canonical: string;
  /** Repo-relative path of `canonical`; null outside the repo. */
  rel: string | null;
}

/** A commit's files and symlinks keyed by repo-relative path, content read once on first use. */
class CommitTree {
  private readonly oids = new Map<string, string>();
  private readonly links = new Map<string, string>();
  private readonly dirs = new Map<string, Map<string, EntryKind>>();
  private readonly canonical = new Map<string, string>();
  private contents: Map<string, string> | undefined;

  constructor(
    readonly root: string,
    commit: string,
  ) {
    for (const blob of listTreeBlobs(root, commit)) {
      const rel = blob.path.split("/").join(path.sep);
      (blob.link ? this.links : this.oids).set(rel, blob.oid);
      this.addEntry(rel, blob.link ? "link" : "file");
    }
  }

  /** The one place an answer's origin is decided; every file, dir and realpath answer goes through it. */
  locate(abs: string, kind: "file" | "dir"): Location {
    return this.classify(this.resolve(path.resolve(abs), 0), kind);
  }

  private classify(canonical: string, kind: "file" | "dir"): Location {
    const rel = relativeInside(this.root, canonical);
    if (rel === null) return { origin: "disk", canonical, rel: null };
    const tracked = kind === "file" ? this.oids.has(rel) : this.dirs.has(rel);
    if (tracked) return { origin: "tree", canonical, rel };
    return { origin: this.ownsBuildOutput(rel, kind === "dir") ? "disk" : "missing", canonical, rel };
  }

  /**
   * Untracked build output a checkout would see on disk: under an excluded dir
   * whose parent the commit tracks, so `untracked/dist` is as absent as `untracked`.
   * A tracked symlink only lands here when its chain loops or dangles, and is then absent.
   */
  private ownsBuildOutput(rel: string, includeSelf: boolean): boolean {
    const at = firstExcluded(rel, includeSelf);
    if (at < 0 || this.links.has(rel)) return false;
    return this.dirs.has(rel.split(path.sep).slice(0, at).join(path.sep));
  }

  *files(): Generator<string> {
    for (const rel of this.oids.keys()) yield path.join(this.root, rel);
  }

  /** Children of a tracked dir by name, or undefined when the commit has no such dir. */
  children(rel: string): Map<string, EntryKind> | undefined {
    return this.dirs.get(rel);
  }

  read(rel: string): string {
    return this.blob(this.oids.get(rel)!);
  }

  /** Every link target joins the first batch: a checkout resolves links before it reads anything. */
  private blob(oid: string): string {
    this.contents ??= readBlobs(this.root, [
      ...[...this.oids].filter(([r]) => READ_BY_INDEX.test(r)).map(([, o]) => o),
      ...this.links.values(),
    ]);
    // A blob outside READ_BY_INDEX is rare enough to read on its own.
    if (!this.contents.has(oid)) this.contents.set(oid, readBlobs(this.root, [oid]).get(oid)!);
    return this.contents.get(oid)!;
  }

  private tracks(rel: string | null): boolean {
    return rel !== null && (this.oids.has(rel) || this.dirs.has(rel));
  }

  /**
   * Memoized per path and hop budget, so each dir's components are resolved once
   * per budget: a chain cut short by the budget never answers for a shorter one.
   */
  private resolve(abs: string, hops: number): string {
    const key = `${hops}:${abs}`;
    let resolved = this.canonical.get(key);
    if (resolved === undefined) {
      const parent = path.dirname(abs);
      resolved = parent === abs ? abs : this.step(this.resolve(parent, hops), path.basename(abs), hops);
      this.canonical.set(key, resolved);
    }
    return resolved;
  }

  /** Disk is never consulted for a component the commit tracks, a symlink included. */
  private step(dir: string, name: string, hops: number): string {
    const next = path.join(dir, name);
    const rel = relativeInside(this.root, next);
    if (this.tracks(rel)) return next;
    if (hops >= MAX_LINK_HOPS) return next;
    const linkOid = rel === null ? undefined : this.links.get(rel);
    if (linkOid !== undefined) return this.follow(dir, this.blob(linkOid), hops + 1) ?? next;
    const target = linkTarget(next);
    return target === null ? next : this.resolve(target, hops + 1);
  }

  /**
   * A tracked link's target walked one component at a time from `dir`, as a
   * checkout walks it: `..` leaves the dir actually reached, so `gone/..` dangles
   * (null) when `gone` is absent, where lexical normalisation would drop it.
   */
  private follow(dir: string, target: string, hops: number): string | null {
    let at = path.isAbsolute(target) ? path.parse(path.resolve(target)).root : dir;
    for (const name of target.split("/")) {
      if (name === "" || name === ".") continue;
      if (name !== "..") at = this.step(at, name, hops);
      else if (this.isDir(at)) at = path.dirname(at);
      else return null;
    }
    return at;
  }

  private isDir(canonical: string): boolean {
    const { origin } = this.classify(canonical, "dir");
    if (origin !== "disk") return origin === "tree";
    return statSync(canonical, { throwIfNoEntry: false })?.isDirectory() ?? false;
  }

  private addEntry(rel: string, kind: EntryKind): void {
    let child = rel;
    let childKind = kind;
    for (let dir = path.dirname(rel); child !== "."; child = dir, dir = path.dirname(dir)) {
      const key = dir === "." ? "" : dir;
      const known = this.dirs.has(key);
      const children = this.dirs.get(key) ?? new Map<string, EntryKind>();
      children.set(path.basename(child), childKind);
      this.dirs.set(key, children);
      if (known) return;
      childKind = "dir";
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
  return [...seen].sort();
}

/** Untracked build-output dirs on disk under a tracked dir, so a listing agrees with directoryExists. */
function diskBuildDirs(real: FileSystemHost, canonical: string): RuntimeDirEntry[] {
  if (!real.directoryExistsSync(canonical)) return [];
  return real.readDirSync(canonical).filter((e) => e.isDirectory && isExcludedDir(path.basename(e.name)));
}

interface Exists {
  file(abs: string): boolean;
  dir(abs: string): boolean;
}

/** A tracked entry as the real host reports it: a symlink is typed by what it resolves to. */
function treeEntry(at: string, kind: EntryKind, exists: Exists): RuntimeDirEntry {
  if (kind !== "link") return { name: at, isFile: kind === "file", isDirectory: kind === "dir", isSymlink: false };
  return { name: at, isFile: exists.file(at), isDirectory: exists.dir(at), isSymlink: true };
}

/** Entries are named under the path as asked, as the real host names them. */
function readDirAt(tree: CommitTree, real: FileSystemHost, abs: string, exists: Exists): RuntimeDirEntry[] {
  const at = tree.locate(abs, "dir");
  const asAsked = (entry: RuntimeDirEntry) => ({ ...entry, name: path.join(path.resolve(abs), path.basename(entry.name)) });
  if (at.origin === "missing") return missing(abs, "dir");
  if (at.origin === "disk") return real.readDirSync(at.canonical).map(asAsked);
  const entries = new Map<string, RuntimeDirEntry>();
  for (const [name, kind] of tree.children(at.rel!)!) {
    entries.set(name, treeEntry(path.join(path.resolve(abs), name), kind, exists));
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
    readDir: (abs) => readDirAt(tree, real, abs, { file: fileExists, dir: directoryExists }),
    // Like the real host, realpath of an absent path throws.
    realpath: (abs) =>
      fileExists(abs) || directoryExists(abs) ? tree.locate(abs, "file").canonical : missing(abs, "file"),
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
