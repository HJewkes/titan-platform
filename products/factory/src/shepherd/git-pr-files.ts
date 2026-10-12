import type { GitHubPort, PrFile, RepoSlug } from "@titan-design/github";
import type { ShepherdStoreRef } from "./store.js";
import { carryCacheDir, carryStateDir, ensureCache, githubRemote, must, remoteBase, serialized, systemGit, type CarryOptions } from "./tree-carry.js";

/** A PR's diff as GitHub's file list sees it: the head against its merge base with the base branch. */
export interface DiffTarget {
  repo: RepoSlug;
  /** The base branch's name, never a sha, so the diff starts at the merge base as GitHub's does. */
  base: string;
  head: string;
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

/** Fetches the head and the base branch into Shepherd's git cache and diffs them there; a refused git command throws. */
export async function gitPrFiles({ repo, base, head }: DiffTarget, options: CarryOptions = {}): Promise<PrFile[]> {
  const git = options.git ?? systemGit;
  const dir = carryCacheDir(carryStateDir(options.stateDir), repo);
  const url = (options.remote ?? githubRemote)(repo);
  const range = `${remoteBase(base)}...${head}`;
  return serialized(dir, async () => {
    await ensureCache(git, dir, options.signal);
    await must(git, dir, ["fetch", "--no-tags", "--no-write-fetch-head", "--quiet", url, head, `+refs/heads/${base}:${remoteBase(base)}`], options.signal);
    const nameStatus = await must(git, dir, ["diff", "--name-status", "-z", "-M", range], options.signal);
    const numstat = await must(git, dir, ["diff", "--numstat", "-z", "-M", range], options.signal);
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
    const key = [target.repo.toLowerCase(), target.base, target.head].join("\0");
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
export interface FilesTarget {
  repo: RepoSlug;
  pr: number;
  head?: string;
  base?: string;
}

/**
 * The PR's files from local git when the head and base are known, else from GitHub. A git failure falls back to GitHub,
 * so a head not yet fetchable still gets its files read rather than an unread class.
 */
export async function prFilesOf(port: GitHubPort, target: FilesTarget, local: PrFilesRead = localPrFiles): Promise<PrFile[]> {
  const { repo, pr, head, base } = target;
  if (head !== undefined && base !== undefined) {
    try {
      return await local({ repo, base, head });
    } catch {
      return port.listPrFiles(repo, pr);
    }
  }
  return port.listPrFiles(repo, pr);
}
