import { ROUTE_META_KEYS } from "../routing/index.js";
import type { AgentIdentity } from "./types.js";
import { inferWorkRole } from "./work-role.js";

/**
 * CC-915: what a later task-to-eval exporter and throughput model need about an agent that
 * nothing else keeps. A squash merge and branch cleanup lose a worktree's base commit for good,
 * and a role read back out of a profile name is a guess, so both are written on the agent's own
 * rows while they are known.
 */

export const WORK_ROLES = [
  "implementer",
  "reviewer",
  "shepherd-review",
  "planner",
  "other",
] as const;

/** One of {@link WORK_ROLES}, or `fix-round-<n>` for Shepherd's n-th fix round. */
export type WorkRole = (typeof WORK_ROLES)[number] | `fix-round-${number}`;

const FIX_ROUND_ROLE = /^fix-round-[1-9]\d*$/;

export const isWorkRole = (value: string): value is WorkRole =>
  (WORK_ROLES as readonly string[]).includes(value) ||
  FIX_ROUND_ROLE.test(value);

export const WORK_ROLE_CHOICES = `${WORK_ROLES.join(", ")}, fix-round-<n>`;

export interface ExperimentArm {
  id: string;
  arm: string;
}

/** Runs `git <args>` in `cwd`; null when git fails, so a missing config reads as absent. */
export type GitRunner = (args: string[], cwd: string) => Promise<string | null>;

/** What provenance reads of an allocation: the ref the isolation strategy recorded. */
export interface ProvenanceAllocation {
  cwd: string;
  ref?: Record<string, string>;
}

const GITHUB_REMOTE = /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/;

/** `owner/name` of a GitHub remote URL; undefined for any other remote. */
export const githubRepoOf = (url: string): string | undefined =>
  GITHUB_REMOTE.exec(url.trim())?.[1];

/**
 * The configured origin URL, not `remote get-url`'s: that one applies `insteadOf`
 * rewrites, which turn a GitHub URL into a mirror path with no owner in it.
 */
async function originRepo(
  gitRoot: string,
  git: GitRunner
): Promise<string | undefined> {
  const url = await git(["config", "--get", "remote.origin.url"], gitRoot);
  return url === null ? undefined : githubRepoOf(url);
}

/**
 * `ref.base` is the tip a new branch WOULD be cut from, so it is the branch's base
 * only when this allocation cut one: a new branch at spawn, or a fresh one at
 * resume. A reused, surviving or assigned branch started somewhere else.
 */
const cutBranch = (ref: Record<string, string>): boolean =>
  ref.reused !== "true" &&
  ref.assigned !== "true" &&
  (ref.reattached ?? "fresh") === "fresh";

/**
 * The worktree half of the provenance, as row meta: repo, branch and base. A
 * branch this allocation did not cut records no base rather than a wrong one; a
 * non-worktree allocation records nothing.
 */
export async function worktreeProvenance(
  allocation: ProvenanceAllocation,
  git: GitRunner
): Promise<Record<string, string>> {
  const ref = allocation.ref;
  if (ref?.gitRoot === undefined) return {};
  const repo = await originRepo(ref.gitRoot, git);
  return {
    ...(repo === undefined ? {} : { repo }),
    ...(ref.branch === undefined ? {} : { branch: ref.branch }),
    ...(ref.base && ref.base_ref && cutBranch(ref)
      ? { base_sha: ref.base, base_ref: ref.base_ref }
      : {}),
    ...(ref.reattached === undefined ? {} : { reattached: ref.reattached }),
  };
}

const nonEmpty = (value: unknown): boolean => typeof value === 'string' && value.trim() !== ''

/** CC-168: frames arrive from more than one surface, so the shape is checked here and not only by the tool. */
export const isExperimentArm = (value: unknown): value is ExperimentArm =>
  typeof value === 'object' && value !== null && 'id' in value && 'arm' in value && nonEmpty(value.id) && nonEmpty(value.arm)

/**
 * A burndown spawn always runs a task, so one without an id is a caller bug that
 * would leave the run unattributable; a role outside the vocabulary is refused
 * rather than recorded, since the exporter groups by it.
 */
export function assignmentRefusal(req: {
  task?: string
  workRole?: string
  spawnedAs?: string
  experiment?: ExperimentArm
}): string | undefined {
  if (req.experiment !== undefined && !isExperimentArm(req.experiment))
    return 'experiment needs a non-empty id and arm'
  if (req.workRole !== undefined && !isWorkRole(req.workRole))
    return `role must be one of: ${WORK_ROLE_CHOICES}; got "${req.workRole}"`
  if (req.spawnedAs === 'burndown' && (req.task ?? '').trim() === '')
    return 'a burndown spawn needs a task id; send `task` with the frame'
  return undefined
}

export type AssignmentRequest = {
  task?: string;
  workRole?: string;
  name: string;
  experiment?: ExperimentArm;
  slice?: string;
  routeOverride?: string;
  /** The `route_*` meta a dispatcher decided; only the keys `/routing` defines are written. */
  route?: Readonly<Record<string, string>>;
};

const routeMetaOf = (
  route: Readonly<Record<string, string>> | undefined
): Record<string, string> =>
  Object.fromEntries(
    ROUTE_META_KEYS.flatMap((key) =>
      route?.[key] === undefined ? [] : [[key, route[key]] as const]
    )
  );

/** The task and role half, as row meta; `work_role_inferred` marks a role nobody stated. */
export function assignmentMeta(
  req: AssignmentRequest,
  profile: string
): Record<string, string> {
  return {
    ...(req.task === undefined ? {} : { task: req.task }),
    ...(req.slice === undefined ? {} : { slice: req.slice }),
    ...routeMetaOf(req.route),
    ...(req.routeOverride === undefined
      ? {}
      : { route_override: req.routeOverride }),
    ...(req.experiment === undefined
      ? {}
      : {
          experiment_id: req.experiment.id.trim(),
          experiment_arm: req.experiment.arm.trim(),
        }),
    ...(req.workRole === undefined
      ? {
          work_role: inferWorkRole(profile, req.name),
          work_role_inferred: "true",
        }
      : { work_role: req.workRole }),
  };
}

/** Everything a spawn row carries: the worktree half from the allocation, the assignment half from the request. */
export async function spawnProvenance(
  allocation: ProvenanceAllocation,
  req: AssignmentRequest,
  profile: string,
  git: GitRunner
): Promise<Record<string, string>> {
  return {
    ...(await worktreeProvenance(allocation, git)),
    ...assignmentMeta(req, profile),
  };
}

/**
 * A teleport successor stands in its predecessor's tree on its predecessor's task,
 * so it carries the predecessor's folded provenance rather than re-deriving it: the
 * fold already holds a base a fresh-branch resume replaced, and a stated role stays
 * stated rather than becoming a guess from the profile.
 */
export function successorProvenance(
  predecessor: AgentIdentity | undefined
): Record<string, string> {
  if (predecessor === undefined) return {};
  const { repo, branch, base, task, workRole, workRoleInferred } = predecessor;
  return {
    ...(repo === undefined ? {} : { repo }),
    ...(branch === undefined ? {} : { branch }),
    ...(base === undefined ? {} : { base_sha: base.sha, base_ref: base.ref }),
    ...(task === undefined ? {} : { task }),
    ...(workRole === undefined ? {} : { work_role: workRole }),
    ...(workRoleInferred ? { work_role_inferred: "true" } : {}),
  };
}
