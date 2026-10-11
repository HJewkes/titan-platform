import { GITHUB_ACTIONS_APP_ID, type CheckRun, type GitHubPort, type RepoSlug } from "@titan-design/github";
import { deadline } from "../workflows/deadline.js";
import { failureOf } from "./error-class.js";
import { DEFAULT_FIX_INITIATIVE, initiativeOf } from "./fix-initiative.js";
import type { FixTaskFields, FixTasks } from "./main-red.js";

export const RELEASE_FOLLOW_STEP = "sh-release-follow";
/** The job in `.github/workflows/release.yml`; it posts a check run of this name on the main tip it publishes from. */
const RELEASE_JOB = "release";
/** Main CI, then the Release workflow, then npm's own propagation: anything slower is recorded, not waited for. */
export const RELEASE_FOLLOW_TIMEOUT_MS = 45 * 60_000;
const RELEASE_FOLLOW_POLL_MS = 30_000;

const FAILED_CONCLUSIONS = new Set(["failure", "timed_out", "startup_failure"]);

/** True when the registry serves `name@version`, false when it answers 404; any other answer throws. */
export type VersionRegistry = (name: string, version: string) => Promise<boolean>;

export function npmVersionRegistry(fetchImpl: typeof fetch = fetch): VersionRegistry {
  return async (name, version) => {
    const response = await fetchImpl(`https://registry.npmjs.org/${name.replace("/", "%2f")}/${encodeURIComponent(version)}`);
    if (response.status === 404) return false;
    if (!response.ok) throw new Error(`registry.npmjs.org answered ${response.status} for ${name}@${version}`);
    return true;
  };
}

/** The Release workflow's job at `mergeSha`; absent until CI on main finishes, and skipped when a newer push took over the publish. */
export async function findReleaseRun(port: GitHubPort, repo: RepoSlug, mergeSha: string): Promise<CheckRun | undefined> {
  const runs = await port.checkRuns(repo, mergeSha);
  return runs.find((run) => run.name === RELEASE_JOB && run.appId === GITHUB_ACTIONS_APP_ID);
}

function releaseRedKey(repo: RepoSlug, mergeSha: string): string {
  return `release-red:${repo}:${mergeSha}`;
}

export interface ReleaseFollowDeps {
  port: GitHubPort;
  registry: VersionRegistry;
  /** Absent leaves a failed release with the owner: it is recorded and nothing is filed. */
  tasks?: FixTasks;
  now: () => number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  pollMs?: number;
  timeoutMs?: number;
}

interface ReleaseFollowInput {
  repo: RepoSlug;
  pr: number;
  mergeSha: string;
  /** Each public package the release bumped, to the version it should publish. */
  versions: Readonly<Record<string, string>>;
  /** The registration's `<initiative>/<id>` task, which picks the initiative a fix task goes to. */
  task?: string;
}

interface ReleaseFollow {
  outcome: "published" | "failed" | "timeout" | "nothing";
  versions: Record<string, string>;
  /** The `name@version`s npm did not serve when the follow ended. */
  missing: string[];
  releaseRun: { id: number; conclusion: string | null; url: string } | null;
  task: string | null;
  detail: string;
}

/**
 * Follows the release job and npm together, so a skipped job (a newer push publishes instead) or one that never shows
 * still ends once npm has every version. A failed job files one fix task and ends; main stays green, so nothing freezes.
 */
export async function followRelease(deps: ReleaseFollowDeps, input: ReleaseFollowInput, signal: AbortSignal): Promise<ReleaseFollow> {
  const versions = { ...input.versions };
  const base = { versions, missing: [], releaseRun: null, task: null };
  if (Object.keys(versions).length === 0) return { ...base, outcome: "nothing", detail: "the release bumped no public package" };
  const clock = deadline({ now: deps.now, sleep: deps.sleep, timeoutMs: deps.timeoutMs ?? RELEASE_FOLLOW_TIMEOUT_MS });
  for (;;) {
    const run = await findReleaseRun(deps.port, input.repo, input.mergeSha).catch(() => undefined);
    const releaseRun = run ? { id: run.id, conclusion: run.conclusion, url: run.url } : null;
    if (run?.status === "completed" && FAILED_CONCLUSIONS.has(run.conclusion ?? "")) {
      const filed = await fileReleaseFixTask(deps.tasks, input, run);
      return { ...base, outcome: "failed", missing: await missingVersions(deps.registry, versions), releaseRun, ...filed };
    }
    const missing = await missingVersions(deps.registry, versions);
    if (missing.length === 0) return { ...base, outcome: "published", releaseRun, detail: "npm serves every version" };
    if (clock.expired()) return { ...base, outcome: "timeout", missing, releaseRun, detail: `npm did not serve ${missing.join(", ")} in time` };
    await clock.sleep(deps.pollMs ?? RELEASE_FOLLOW_POLL_MS, signal);
  }
}

/** A registry that cannot be read counts the version as missing, so the next poll asks again. */
async function missingVersions(registry: VersionRegistry, versions: Readonly<Record<string, string>>): Promise<string[]> {
  const missing: string[] = [];
  for (const [name, version] of Object.entries(versions)) if (!(await registry(name, version).catch(() => false))) missing.push(`${name}@${version}`);
  return missing;
}

/** The key tag makes a repeated follow of the same merge find its task rather than file another. */
async function fileReleaseFixTask(tasks: FixTasks | undefined, input: ReleaseFollowInput, run: CheckRun): Promise<{ task: string | null; detail: string }> {
  if (!tasks) return { task: null, detail: "the release job failed and no active-work port is wired" };
  const initiative = initiativeOf(input.task) ?? DEFAULT_FIX_INITIATIVE;
  const key = releaseRedKey(input.repo, input.mergeSha);
  try {
    const id = (await tasks.findByTag(initiative, key)) ?? (await tasks.add(initiative, releaseFixFields(input, run, key)));
    return { task: `${initiative}/${id}`, detail: "the release job failed" };
  } catch (error) {
    return { task: null, detail: `the release job failed and active-work did not take the fix task: ${failureOf(error)}` };
  }
}

function releaseFixFields(input: ReleaseFollowInput, run: CheckRun, key: string): FixTaskFields {
  const short = input.mergeSha.slice(0, 7);
  const wanted = Object.entries(input.versions).map(([name, version]) => `${name}@${version}`);
  const notes = [
    `Shepherd filed this when the ${RELEASE_JOB} job concluded ${run.conclusion} on ${input.repo} after Version Packages #${input.pr} merged as ${input.mergeSha}. Main CI is green, so merges are not frozen. Key: ${key}.`,
    `- ${run.name}: ${run.url}`,
    `Versions to publish: ${wanted.join(", ")}`,
  ].join("\n\n");
  return { title: `release failed on ${input.repo} at ${short}`, severity: "high", done_when: `registry.npmjs.org serves ${wanted.join(", ")}.`, tags: ["shepherd", "release-red", key], notes };
}
