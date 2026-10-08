import path from "node:path";
import { ghCliWire, githubPort, type GitHubPort } from "@titan-design/github";
import { findGitRoot, runGit, type GitRunner } from "@titan-design/worktree";
import { taskIdsIn, type PrEvidence, type RefEvidence } from "./task-stage.js";

/** One local clone's stage evidence. Only local refs are read: the console never fetches. */
export interface RepoEvidence {
  /** `owner/name` from the origin remote, else the clone's directory name; never an absolute path. */
  repo: string;
  /** Worktree branches, and branches not merged into the main line by ancestry. */
  refs: RefEvidence[];
  /** Unix seconds of the newest `<ID>: …` subject on the main line, per id. */
  mergedAt: Map<string, number>;
  /** Null when GitHub could not be read; `degraded` then says why. */
  openPrs: PrEvidence[] | null;
  degraded?: string;
}

/** Reads evidence for the given clones, deduplicated by repository so a worktree path costs nothing extra. */
export type EvidenceReader = (repoPaths: readonly string[]) => Promise<RepoEvidence[]>;

export interface GitEvidenceOptions {
  git?: GitRunner;
  github?: Pick<GitHubPort, "listOpenPrs">;
  ttlMs?: number;
  now?: () => number;
}

const EVIDENCE_TTL_MS = 60_000;

/** One cached git and GitHub read per repository per minute, however many tasks or requests ask. */
export function gitEvidenceReader(options: GitEvidenceOptions = {}): EvidenceReader {
  const git = options.git ?? runGit;
  const github = options.github ?? githubPort(ghCliWire());
  const now = options.now ?? Date.now;
  const cache = new Map<string, { at: number; read: Promise<RepoEvidence | null> }>();
  const cached = (root: string): Promise<RepoEvidence | null> => {
    const hit = cache.get(root);
    if (hit && now() - hit.at < (options.ttlMs ?? EVIDENCE_TTL_MS)) return hit.read;
    const read = readRepo(root, git, github);
    cache.set(root, { at: now(), read });
    return read;
  };
  return async (repoPaths) => {
    const roots = await Promise.all([...new Set(repoPaths)].map((repoPath) => findGitRoot(repoPath, git)));
    const read = await Promise.all([...new Set(roots.filter((root): root is string => root !== null))].map(cached));
    return read.filter((entry): entry is RepoEvidence => entry !== null);
  };
}

async function readRepo(root: string, git: GitRunner, github: Pick<GitHubPort, "listOpenPrs">): Promise<RepoEvidence | null> {
  const base = (await git(["rev-parse", "--abbrev-ref", "origin/HEAD"], root)) ?? "origin/main";
  const [tips, unmerged, worktrees, log, remote] = await Promise.all([
    git(["for-each-ref", "--format=%(refname:short)%09%(committerdate:unix)", "refs/heads", "refs/remotes/origin"], root),
    git(["for-each-ref", `--no-merged=${base}`, "--format=%(refname:short)", "refs/heads", "refs/remotes/origin"], root),
    git(["worktree", "list", "--porcelain"], root),
    git(["log", "--format=%ct%x09%s", base], root),
    git(["remote", "get-url", "origin"], root),
  ]);
  if (tips === null) return null;
  const slug = remote === null ? null : githubSlug(remote);
  const repo = slug ?? path.basename(root);
  // The main checkout is a worktree too; its base branch carries no task.
  const branches = worktreeBranches(worktrees).filter((name) => `origin/${name}` !== base);
  const refs = refsOf(repo, tipTimes(tips), lines(unmerged), branches);
  return { repo, refs, mergedAt: mergedAt(log), ...(await openPrsOf(repo, slug, github)) };
}

async function openPrsOf(repo: string, slug: string | null, github: Pick<GitHubPort, "listOpenPrs">): Promise<Pick<RepoEvidence, "openPrs" | "degraded">> {
  if (slug === null) return { openPrs: null, degraded: `${repo} has no GitHub origin` };
  try {
    const open = await github.listOpenPrs(slug);
    return { openPrs: open.map((pr) => ({ repo, number: pr.number, headRef: pr.headRef })) };
  } catch (error) {
    return { openPrs: null, degraded: `Open pull requests in ${repo} unread: ${error instanceof Error ? error.message : String(error)}` };
  }
}

const lines = (text: string | null): string[] => (text ?? "").split("\n").filter((line) => line.length > 0);

function tipTimes(text: string): Map<string, number> {
  return new Map(lines(text).map((line) => {
    const [name, at] = line.split("\t");
    return [name!, Number(at)] as const;
  }));
}

function worktreeBranches(text: string | null): string[] {
  return lines(text).filter((line) => line.startsWith("branch refs/heads/")).map((line) => line.slice("branch refs/heads/".length));
}

function refsOf(repo: string, tips: Map<string, number>, unmerged: string[], worktrees: string[]): RefEvidence[] {
  const ref = (name: string, kind: RefEvidence["kind"]): RefEvidence => ({ repo, name, kind, tipAt: tips.get(name) ?? 0 });
  const onWorktree = new Set(worktrees);
  // `origin/HEAD` lists as the bare remote name.
  const branches = unmerged.filter((name) => name !== "origin" && !onWorktree.has(name));
  return [...worktrees.map((name) => ref(name, "worktree")), ...branches.map((name) => ref(name, "branch"))];
}

const MERGED_SUBJECT = /^([A-Z][A-Z0-9]*-\d+):/;

function mergedAt(log: string | null): Map<string, number> {
  const newest = new Map<string, number>();
  for (const line of lines(log)) {
    const [at, subject] = line.split("\t");
    const id = MERGED_SUBJECT.exec(subject ?? "")?.[1];
    if (id && !newest.has(id)) newest.set(id, Number(at));
  }
  return newest;
}

function githubSlug(remote: string): string | null {
  return /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec(remote.trim())?.[1] ?? null;
}

/** Groups refs and pull requests under each task id their names carry. */
export function indexByTaskId<T extends { name?: string; headRef?: string }>(entries: readonly T[]): Map<string, T[]> {
  const index = new Map<string, T[]>();
  for (const entry of entries) {
    for (const id of new Set(taskIdsIn(entry.name ?? entry.headRef ?? ""))) index.set(id, [...(index.get(id) ?? []), entry]);
  }
  return index;
}
