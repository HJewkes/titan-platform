import type { GitHubPort, PrFile, RepoSlug } from "@titan-design/github";
import type { ShepherdStoreRef } from "./store.js";
import { CarryRefusal, carryCacheDir, carryStateDir, ensureCache, githubRemote, isAncestor, must, remoteBase, serialized, systemGit, type CarryOptions, type Git } from "./tree-carry.js";

/** A PR's diff as GitHub's file list sees it: the head against its merge base with the base branch. */
export interface DiffTarget {
  repo: RepoSlug;
  /** The PR whose `refs/pull/<n>` refs the caller's head and base are checked against. */
  pr: number;
  /** The base branch's name, as the registering caller gave it. */
  base: string;
  head: string;
}

/** The caller's head or base is not the PR's, as GitHub's own pull refs show it; the files are read from GitHub instead. */
class PrFactsMismatch extends Error {
  constructor(readonly fact: "head" | "merge ref" | "base") {
    super(`the registered ${fact} is not the pull request's`);
    this.name = "PrFactsMismatch";
  }
}

/** A PR always changes something, so an empty diff means the head or base was wrong; it reads as unread, never as 0 lines. */
class EmptyPrDiff extends Error {
  constructor() {
    super("git diff of the pull request is empty");
    this.name = "EmptyPrDiff";
  }
}

/** Past its rename limit git exits 0 but skips copy sources, so a policy file's copy could read as a plain add. */
export class CopyDetectionSkipped extends Error {
  constructor() {
    super("git skipped copy detection on the pull request's diff");
    this.name = "CopyDetectionSkipped";
  }
}

export type PrFilesRead = (target: DiffTarget) => Promise<PrFile[]>;

/** Git's status letters as GitHub's file list spells them; a rename's score digits are dropped first. */
const STATUS: Readonly<Record<string, string>> = { A: "added", D: "removed", M: "modified", R: "renamed", C: "copied", T: "changed" };

interface NameStatus {
  status: string;
  path: string;
  previousPath?: string;
}

/** `git diff --name-status -z`: a status, then one path, or the old and new paths of a rename or copy. */
export function parseNameStatus(raw: string): NameStatus[] {
  const fields = raw.split("\0").filter((field) => field !== "");
  const entries: NameStatus[] = [];
  for (let i = 0; i < fields.length; ) {
    const letter = fields[i++]!.charAt(0);
    const status = STATUS[letter] ?? "changed";
    if (letter === "R" || letter === "C") {
      const previousPath = fields[i++]!;
      entries.push({ status, path: fields[i++]!, previousPath });
    } else entries.push({ status, path: fields[i++]! });
  }
  return entries;
}

/** `git diff --numstat -z`, keyed by new path; a binary file's `-` counts are 0, as GitHub reports them. */
export function parseNumstat(raw: string): Map<string, { additions: number; deletions: number }> {
  const fields = raw.split("\0");
  const counts = new Map<string, { additions: number; deletions: number }>();
  for (let i = 0; i < fields.length; i++) {
    const match = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(fields[i]!);
    if (!match) continue;
    const path = match[3] === "" ? fields[(i += 2)]! : match[3]!;
    counts.set(path, { additions: Number(match[1] === "-" ? 0 : match[1]), deletions: Number(match[2] === "-" ? 0 : match[2]) });
  }
  return counts;
}

function prFilesOfDiff(nameStatus: string, numstat: string): PrFile[] {
  const counts = parseNumstat(numstat);
  return parseNameStatus(nameStatus).map((entry) => ({ ...entry, ...(counts.get(entry.path) ?? { additions: 0, deletions: 0 }) }));
}

const pullRef = (pr: number, name: "head" | "merge"): string => `refs/remotes/pull/${pr}/${name}`;

/**
 * The base commit GitHub merged the head onto, once the caller's facts are checked: `refs/pull/<n>/head` is the head,
 * the merge ref's second parent is the head, and its first parent is on the named base branch. Diffing from that parent
 * rather than the named branch keeps a branch that already holds the head from shrinking the diff.
 */
async function verifiedBase(git: Git, dir: string, { pr, base, head }: DiffTarget, signal?: AbortSignal): Promise<string> {
  if ((await must(git, dir, ["rev-parse", pullRef(pr, "head")], signal)) !== head) throw new PrFactsMismatch("head");
  const [, baseParent, headParent] = (await must(git, dir, ["rev-list", "--parents", "-n", "1", pullRef(pr, "merge")], signal)).split(" ");
  if (headParent !== head || baseParent === undefined) throw new PrFactsMismatch("merge ref");
  if (!(await isAncestor(git, dir, baseParent, remoteBase(base), signal))) throw new PrFactsMismatch("base");
  return baseParent;
}

function fetchArgs(url: string, { pr, base }: DiffTarget): string[] {
  const refs = [`+refs/heads/${base}:${remoteBase(base)}`, `+refs/pull/${pr}/head:${pullRef(pr, "head")}`, `+refs/pull/${pr}/merge:${pullRef(pr, "merge")}`];
  return ["fetch", "--no-tags", "--no-write-fetch-head", "--quiet", url, ...refs];
}

/**
 * Copies are sought against every base file, unmodified ones included, so a fresh-name copy of a policy file is listed
 * with the policy file as its source and keeps that file's class. Lines are counted without copies, so a copy counts
 * whole, as GitHub counts it: a large file copied from a base file still crosses the line threshold.
 */
const COPY_FLAGS = ["-z", "-M", "-C", "--find-copies-harder"] as const;
const LINE_FLAGS = ["-z", "-M"] as const;

/** Git's rename-limit warnings; the config name is matched because git does not translate it, the phrase as a fallback. */
const SKIPPED_COPIES = /diff\.renameLimit|too many files/;

/** Stderr is only matched, never quoted, since it can echo the remote's URL. */
async function diffNameStatus(git: Git, dir: string, range: string, signal?: AbortSignal): Promise<string> {
  const result = await git(dir, ["diff", "--name-status", ...COPY_FLAGS, range], signal);
  if (result.code !== 0) throw new CarryRefusal("diff", result.code);
  if (SKIPPED_COPIES.test(result.stderr)) throw new CopyDetectionSkipped();
  return result.stdout.trim();
}

/**
 * Fetches the base branch and the PR's pull refs into Shepherd's git cache and diffs the head there, over the git
 * protocol, so no REST read is spent. A refused git command, a fact that is not the PR's, an empty diff, or a diff
 * whose copy detection git skipped throws.
 */
export async function gitPrFiles(target: DiffTarget, options: CarryOptions = {}): Promise<PrFile[]> {
  const git = options.git ?? systemGit;
  const dir = carryCacheDir(carryStateDir(options.stateDir), target.repo);
  const url = (options.remote ?? githubRemote)(target.repo);
  return serialized(dir, async () => {
    await ensureCache(git, dir, options.signal);
    await must(git, dir, fetchArgs(url, target), options.signal);
    const range = `${await verifiedBase(git, dir, target, options.signal)}...${target.head}`;
    const nameStatus = await diffNameStatus(git, dir, range, options.signal);
    if (nameStatus === "") throw new EmptyPrDiff();
    const numstat = await must(git, dir, ["diff", "--numstat", ...LINE_FLAGS, range], options.signal);
    return prFilesOfDiff(nameStatus, numstat);
  });
}

const CACHE_ENTRIES = 256;

/**
 * One read per repo, base and head: a head's merge base with its base branch moves only when the head does, so a new
 * head is a new diff while a PR number names many. A failed read is not kept, so the next asks git again.
 */
export function cachedByHead(read: PrFilesRead, entries = CACHE_ENTRIES): PrFilesRead {
  const cache = new Map<string, Promise<PrFile[]>>();
  return (target) => {
    const key = [target.repo.toLowerCase(), target.pr, target.base, target.head].join("\0");
    const hit = cache.get(key);
    if (hit) return hit;
    const read$ = read(target);
    cache.set(key, read$);
    read$.catch(() => cache.get(key) === read$ && cache.delete(key));
    if (cache.size > entries) cache.delete(cache.keys().next().value!);
    return read$;
  };
}

/** The serve process's one cached reader over its git cache. */
export const localPrFiles: PrFilesRead = cachedByHead((target) => gitPrFiles(target));

/** The base branch the run's registration named; undefined when it named none, there is no run, or the store cannot be read. */
export function registeredBase(store: ShepherdStoreRef, runId: string | undefined): string | undefined {
  if (runId === undefined) return undefined;
  try {
    return store.get().byRun(runId)?.base ?? undefined;
  } catch {
    return undefined;
  }
}

/** What a file list is read for: a PR, and its head and base branch when the registration names them. */
interface FilesTarget {
  repo: RepoSlug;
  pr: number;
  head?: string;
  base?: string;
}

/**
 * The PR's files from local git when the head and base are known, else from GitHub. A head or base that is not the
 * PR's, or any other git failure, falls back to GitHub's list, so a wrong fact still gets the PR's real class. An empty
 * diff, or one whose copy detection git skipped, throws, so every caller reads it as unread and fails closed: GitHub's
 * list reports a copy as added and would hide its source.
 */
export async function prFilesOf(port: GitHubPort, target: FilesTarget, local: PrFilesRead = localPrFiles): Promise<PrFile[]> {
  const { repo, pr, head, base } = target;
  if (head === undefined || base === undefined) return port.listPrFiles(repo, pr);
  try {
    return await local({ repo, pr, base, head });
  } catch (error) {
    if (error instanceof EmptyPrDiff || error instanceof CopyDetectionSkipped) throw error;
    return port.listPrFiles(repo, pr);
  }
}
