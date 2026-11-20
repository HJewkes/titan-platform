import path from "node:path";
import { z } from "zod";
import { ArtifactsSchema, type WorktreeEntry } from "../schemas/artifacts.js";
import { getInitiativeDir, getLockPath } from "../utils/paths.js";
import { withFileLock } from "../utils/fs-atomic.js";
import { readYaml } from "../utils/yaml-io.js";
import { defineCommand } from "../registry/index.js";
import {
  getGhRunner,
  resolveLocalRepoPath,
  resolveOrgRepo,
} from "../utils/git-gh.js";
import { parseGhPrList } from "../utils/gh-pr-wire.js";
import {
  isBranchPresent,
  readAheadBehind,
  readLastCommitIso,
  summarizeChecks,
} from "../utils/branch-probes.js";
import { readWorktreeState } from "../utils/git-worktrees.js";
import { mapConcurrent } from "../utils/map-concurrent.js";

const ArgsSchema = z.object({
  slug: z.string().min(1),
});

const PrInfoSchema = z.object({
  number: z.number().int(),
  state: z.string(),
  title: z.string(),
  url: z.string(),
  checks: z.string().optional(),
});

const BranchStatusSchema = z.object({
  repo: z.string(),
  name: z.string(),
  note: z.string().optional(),
  present: z.boolean(),
  last_commit_iso: z.string().nullable(),
  ahead: z.number().int().nullable(),
  behind: z.number().int().nullable(),
  pr: PrInfoSchema.nullable(),
  error: z.string().optional(),
});

/**
 * Persisted worktree identity plus live state read from git. The live half
 * is never written back to `artifacts.yml` — see `src/schemas/artifacts.ts`.
 */
const WorktreeStatusSchema = z.object({
  path: z.string(),
  repo: z.string(),
  branch: z.string().nullable(),
  holding: z.string().optional(),
  pr: z.number().int().optional(),
  note: z.string().optional(),
  present: z.boolean(),
  /** Null when git could not read the tree. Unknown is not clean. */
  dirty: z.boolean().nullable(),
  files_changed: z.number().int().nullable(),
  ahead: z.number().int().nullable(),
  behind: z.number().int().nullable(),
  has_upstream: z.boolean(),
});

const ResultSchema = z.object({
  slug: z.string(),
  branches: z.array(BranchStatusSchema),
  worktrees: z.array(WorktreeStatusSchema),
});

type Args = z.infer<typeof ArgsSchema>;
type Result = z.infer<typeof ResultSchema>;
type BranchStatus = z.infer<typeof BranchStatusSchema>;
type WorktreeStatus = z.infer<typeof WorktreeStatusSchema>;
type PrInfo = z.infer<typeof PrInfoSchema>;

interface BranchInput {
  repo: string;
  name: string;
  note?: string;
}

const MAX_CONCURRENCY = 8;

export { setGitRunner, setGhRunner, resetRunners } from "../utils/git-gh.js";

async function fetchPrInfo(
  orgRepo: string,
  name: string
): Promise<PrInfo | null> {
  const gh = getGhRunner();
  try {
    const res = await gh("gh", [
      "pr",
      "list",
      "--head",
      name,
      "--repo",
      orgRepo,
      "--json",
      "number,state,title,url,statusCheckRollup",
      "--limit",
      "1",
    ]);
    if (res.code !== 0) return null;
    const first = parseGhPrList(res.stdout)?.entries[0];
    if (
      !first ||
      typeof first.number !== "number" ||
      typeof first.state !== "string" ||
      typeof first.title !== "string" ||
      typeof first.url !== "string"
    ) {
      return null;
    }
    const checks = summarizeChecks(first.statusCheckRollup ?? []);
    return {
      number: first.number,
      state: first.state,
      title: first.title,
      url: first.url,
      ...(checks ? { checks } : {}),
    };
  } catch {
    return null;
  }
}

async function statusForBranch(branch: BranchInput): Promise<BranchStatus> {
  const out: BranchStatus = {
    repo: branch.repo,
    name: branch.name,
    ...(branch.note ? { note: branch.note } : {}),
    present: false,
    last_commit_iso: null,
    ahead: null,
    behind: null,
    pr: null,
  };

  const repoPath = resolveLocalRepoPath(branch.repo);

  try {
    if (repoPath) {
      out.present = await isBranchPresent(repoPath, branch.name);
      if (out.present) {
        out.last_commit_iso = await readLastCommitIso(repoPath, branch.name);
        const { ahead, behind } = await readAheadBehind(repoPath, branch.name);
        out.ahead = ahead;
        out.behind = behind;
      }
    }

    const orgRepo = await resolveOrgRepo(branch.repo);
    if (orgRepo) {
      out.pr = await fetchPrInfo(orgRepo, branch.name);
    }
  } catch (err) {
    out.error = err instanceof Error ? err.message : String(err);
  }

  return out;
}

async function statusForWorktree(
  entry: WorktreeEntry
): Promise<WorktreeStatus> {
  const live = await readWorktreeState(entry.path);
  return {
    path: entry.path,
    repo: entry.repo,
    branch: live.branch ?? entry.branch ?? null,
    ...(entry.holding ? { holding: entry.holding } : {}),
    ...(entry.pr ? { pr: entry.pr } : {}),
    ...(entry.note ? { note: entry.note } : {}),
    present: live.present,
    dirty: live.dirty,
    files_changed: live.files_changed,
    ahead: live.ahead,
    behind: live.behind,
    has_upstream: live.has_upstream,
  };
}

const artifactStatus = defineCommand<Args, Result>({
  name: "artifact.status",
  description:
    "Pull live PR and branch state for the initiative via `git` + `gh`. Read-only.",
  args: ArgsSchema,
  result: ResultSchema,
  cli: {
    positional: ["slug"],
  },
  async run(args) {
    const artifactsPath = path.join(
      getInitiativeDir(args.slug),
      "artifacts.yml"
    );
    const current = await withFileLock(getLockPath(args.slug), () =>
      readYaml(artifactsPath, ArtifactsSchema)
    );
    const branches = await mapConcurrent(
      current.branches,
      MAX_CONCURRENCY,
      statusForBranch
    );
    const worktrees = await mapConcurrent(
      current.worktrees,
      MAX_CONCURRENCY,
      statusForWorktree
    );
    return { slug: args.slug, branches, worktrees };
  },
});

export default artifactStatus;
