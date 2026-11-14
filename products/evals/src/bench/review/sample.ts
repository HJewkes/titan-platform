import { existsSync } from "node:fs";
import type { BundleGit } from "../../review-pr/bundle.js";
import { benchCaseOf, CASE_TYPES, seededOrder, stratifiedQueue, type CaseType, type ReviewCase, type ReviewCaseBody } from "./cases.js";
import { plantControls } from "./plant.js";
import { repoName } from "./repos.js";

type GitFor = (repo: string) => BundleGit | undefined;

export interface SampleOptions {
  bodies: readonly ReviewCaseBody[];
  gitFor: GitFor;
  seed: string;
  /** Wanted cases per type; `defect` is the real-defect count. */
  counts: Record<CaseType, number>;
}

export interface SampleManifest {
  schema: "titan.bench-r-cases/v1";
  seed: string;
  counts: Record<CaseType, number>;
  byKind: Record<string, Record<CaseType, number>>;
  /** repo name → reason → cases left out before sampling. */
  skipped: Record<string, Record<string, number>>;
  /** Types the pool could not fill to the wanted count. */
  shortfall: Partial<Record<CaseType, number>>;
}

interface Reach {
  gitFor: GitFor;
  repos: Map<string, boolean>;
  skipped: SampleManifest["skipped"];
}

const bump = (skipped: SampleManifest["skipped"], repo: string, reason: string): void => {
  const counts = (skipped[repo] ??= {});
  counts[reason] = (counts[reason] ?? 0) + 1;
};

async function answers(git: BundleGit, args: readonly string[]): Promise<boolean> {
  return git.git(args).then(
    () => true,
    () => false,
  );
}

/** Why a case cannot be bundled from local state alone, or undefined when it can; nothing here fetches. */
async function unreachableReason(body: ReviewCaseBody, reach: Reach): Promise<string | undefined> {
  if (body.tree !== undefined) return existsSync(body.tree) ? undefined : "tree-missing";
  const git = reach.gitFor(body.repo);
  if (git === undefined) return "no-clone";
  const name = repoName(body.repo);
  if (!reach.repos.has(name)) reach.repos.set(name, await answers(git, ["rev-parse", "--git-dir"]));
  if (reach.repos.get(name) !== true) return "no-clone";
  for (const sha of [body.head, body.base]) {
    if (!(await answers(git, ["cat-file", "-e", `${sha}^{commit}`]))) return "unreachable";
  }
  return undefined;
}

async function reachableBodies(bodies: readonly ReviewCaseBody[], reach: Reach): Promise<ReviewCaseBody[]> {
  const kept: ReviewCaseBody[] = [];
  for (const body of bodies) {
    const reason = await unreachableReason(body, reach);
    if (reason === undefined) kept.push(body);
    else bump(reach.skipped, repoName(body.repo), reason);
  }
  return kept;
}

function manifestOf(options: SampleOptions, cases: readonly ReviewCaseBody[], skipped: SampleManifest["skipped"]): SampleManifest {
  const counts = { defect: 0, planted: 0, clean: 0 };
  const byKind: SampleManifest["byKind"] = {};
  for (const item of cases) {
    counts[item.caseType] += 1;
    const row = (byKind[item.kind] ??= { defect: 0, planted: 0, clean: 0 });
    row[item.caseType] += 1;
  }
  const shortfall = Object.fromEntries(CASE_TYPES.filter((type) => counts[type] < options.counts[type]).map((type) => [type, options.counts[type] - counts[type]]));
  return { schema: "titan.bench-r-cases/v1", seed: options.seed, counts, byKind, skipped, shortfall };
}

/**
 * The R sample: real defects and clean heads drawn across all splits, existing controls first and new plants on dev
 * clean heads after them. A head planted on, now or by an existing control, is never also a clean case.
 */
export async function buildReviewSample(options: SampleOptions): Promise<{ queue: ReviewCase[]; manifest: SampleManifest }> {
  const skipped: SampleManifest["skipped"] = {};
  const reachable = await reachableBodies(options.bodies, { gitFor: options.gitFor, repos: new Map(), skipped });
  const ofType = (type: CaseType): ReviewCaseBody[] => seededOrder(reachable.filter((body) => body.caseType === type), options.seed, type);
  const controls = ofType("planted").slice(0, options.counts.planted);
  const plantedOn = new Set(controls.map((control) => control.plantedOn));
  const cleanPool = ofType("clean").filter((body) => !plantedOn.has(body.id));
  const devPool = cleanPool.filter((body) => body.split === "dev");
  const planted = await plantControls(devPool, options.counts.planted - controls.length, options.gitFor);
  for (const control of planted) plantedOn.add(control.plantedOn);
  const cleans = cleanPool.filter((body) => !plantedOn.has(body.id)).slice(0, options.counts.clean);
  const sample = [...ofType("defect").slice(0, options.counts.defect), ...controls, ...planted, ...cleans];
  const queue = stratifiedQueue(sample, options.seed).map(benchCaseOf);
  return { queue, manifest: manifestOf(options, sample, skipped) };
}
