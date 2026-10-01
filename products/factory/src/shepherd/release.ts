import type { GitHubPort, PrFile, RepoSlug } from "@titan-design/github";
import type { StepRoute, WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import type { StepDeclaration } from "../definition.js";
import type { GateDecision, PolicyRule } from "../gate-policy.js";
import { codeRoute, step, type LandOptions } from "../workflows/land.js";
import type { FreezeGuard } from "./freeze.js";
import { isGithubPath } from "./merge-facts.js";
import type { ShepherdDeps, Verdict } from "./phases.js";
import type { EffectivePolicy, MergeMode } from "./policy.js";
import type { ShepherdStore } from "./store.js";

/** The branch the changesets action opens its "Version Packages" pull request from. */
export const VERSION_PACKAGES_BRANCH = "changeset-release/main";
/** The registration's implementer: no agent writes this PR, so a wake for it is never handled. */
export const RELEASE_IMPLEMENTER = "changesets";
export const RELEASE_PREFLIGHT_STEP = "sh-release-preflight";
export const RELEASE_STEPS: readonly StepDeclaration[] = [{ id: RELEASE_PREFLIGHT_STEP, kind: "dispatch" }];
/** How long a ready Version Packages head holds the repo's other Shepherd merges; a stuck release cannot hold them longer. */
export const RELEASE_FREEZE_MS = 30 * 60_000;

export function releaseTask(repo: RepoSlug): string {
  return `${repo.split("/")[1] ?? repo}/version-packages`;
}

/** True when the registry has the package, false when it answers 404; any other answer throws. */
export type PackageRegistry = (name: string) => Promise<boolean>;

export function npmRegistry(fetchImpl: typeof fetch = fetch): PackageRegistry {
  return async (name) => {
    const response = await fetchImpl(`https://registry.npmjs.org/${name.replace("/", "%2f")}`, { headers: { accept: "application/vnd.npm.install-v1+json" } });
    if (response.status === 404) return false;
    if (!response.ok) throw new Error(`registry.npmjs.org answered ${response.status} for ${name}`);
    return true;
  };
}

const PACKAGE_FILE = /^(?:[^/]+\/)*(?:package\.json|CHANGELOG\.md)$/;
const CONSUMED_CHANGESET = /^\.changeset\/[^/]+\.md$/;

/** What `changeset version` writes: manifests, changelogs, the lockfile, the regenerated catalog, and consumed changesets. */
export function isReleaseFile(file: PrFile): boolean {
  if (isGithubPath(file.path) || file.previousPath !== undefined) return false;
  if (CONSUMED_CHANGESET.test(file.path)) return file.status === "removed";
  return PACKAGE_FILE.test(file.path) || file.path === "pnpm-lock.yaml" || file.path === "CAPABILITIES.md";
}

export interface ReleaseTarget {
  repo: RepoSlug;
  pr: number;
  head: string;
}

export interface ReleasePreflight {
  head: string;
  /** Each reason the release cannot land; empty means it may. */
  blockers: string[];
  /** The public packages this release publishes. */
  packages: string[];
}

/** Every public package in the release must already exist on npm, because only a package that exists can use trusted publishing. */
export async function releasePreflight(port: GitHubPort, registry: PackageRegistry, target: ReleaseTarget): Promise<ReleasePreflight> {
  const pr = await port.getPr(target.repo, target.pr);
  const blockers = headBlockers(target, pr.headRef, pr.headRepo, pr.headSha);
  const files = await port.listPrFiles(target.repo, target.pr);
  const foreign = files.filter((file) => !isReleaseFile(file)).map((file) => file.path);
  if (foreign.length > 0) blockers.push(`it changes files a release does not write: ${foreign.join(", ")}`);
  const packages = await publicPackages(port, target, files);
  for (const name of packages) blockers.push(...(await registryBlockers(registry, name)));
  return { head: target.head, blockers, packages };
}

function headBlockers(target: ReleaseTarget, headRef: string, headRepo: string | null, headSha: string): string[] {
  const blockers: string[] = [];
  if (headRef !== VERSION_PACKAGES_BRANCH || headRepo?.toLowerCase() !== target.repo.toLowerCase()) blockers.push(`its head is not ${VERSION_PACKAGES_BRANCH} in ${target.repo}`);
  if (headSha !== target.head) blockers.push(`its head moved from ${target.head} to ${headSha}`);
  return blockers;
}

async function registryBlockers(registry: PackageRegistry, name: string): Promise<string[]> {
  try {
    return (await registry(name)) ? [] : [`${name} is not on registry.npmjs.org yet; publish its first version by hand (CLAUDE.md, Releasing)`];
  } catch (error) {
    return [`the registry read for ${name} failed: ${error instanceof Error ? error.message : String(error)}`];
  }
}

const Manifest = z.looseObject({ name: z.string().optional(), private: z.boolean().optional() });

async function publicPackages(port: GitHubPort, target: ReleaseTarget, files: readonly PrFile[]): Promise<string[]> {
  const manifests = files.filter((file) => file.status !== "removed" && file.path.split("/").at(-1) === "package.json");
  const names: string[] = [];
  for (const file of manifests) {
    const read = await port.getFile(target.repo, file.path, target.head);
    const manifest = read && Manifest.safeParse(JSON.parse(read.content));
    if (!manifest?.success) throw new Error(`${file.path} at ${target.head} is not a readable package manifest`);
    if (manifest.data.private !== true && manifest.data.name !== undefined) names.push(manifest.data.name);
  }
  return names.sort();
}

interface PreflightInput extends ReleaseTarget {
  runId: string;
  merge: MergeMode;
}

/** Marks the head ready only under an auto policy, so a release the owner must approve never holds other merges; a run not yet registered marks nothing. */
export function releaseRoutes(deps: ShepherdDeps, registry: PackageRegistry): StepRoute[] {
  return [
    codeRoute(RELEASE_PREFLIGHT_STEP, deps.now, async (input: PreflightInput) => {
      const preflight = await releasePreflight(deps.port, registry, input);
      const ready = preflight.blockers.length === 0 && input.merge === "auto";
      const store = deps.store.get();
      if (store.byRun(input.runId)) store.setReleaseReady(input.runId, ready ? input.head : null);
      return preflight;
    }),
  ];
}

const PreflightResult = z.looseObject({ head: z.string(), blockers: z.array(z.string()), packages: z.array(z.string()) });

/** The Version Packages PR is reviewed by its preflight, not by an agent: changesets wrote it, and the preflight checks exactly that. */
export async function releaseVerdict(ctx: WorkflowContext, target: ReleaseTarget, merge: MergeMode): Promise<Verdict> {
  const preflight = await step(ctx, `${RELEASE_PREFLIGHT_STEP}:${target.head}`, { ...target, runId: ctx.runId, merge }, PreflightResult);
  return { kind: "MERGE", headSha: target.head, evidence: { release: preflight } };
}

const releaseRule = (rowId: string): PolicyRule => ({ table: "shepherd-release", rowId, version: 1 });

/** The release gate: a passed preflight at this exact head merges under an auto seat; every other row is the owner's. */
export function decideRelease(effective: EffectivePolicy, headSha: string | undefined, preflight: ReleasePreflight | undefined): GateDecision {
  if (effective.merge === "never") return { outcome: "deny", rule: releaseRule("never"), reason: `seat ${effective.seat} policy never allows a merge` };
  if (headSha === undefined || preflight?.head !== headSha) return { outcome: "gate", rule: releaseRule("no-preflight"), reason: `no release preflight ran at ${headSha ?? "an unknown head"}` };
  if (preflight.blockers.length > 0) return { outcome: "gate", rule: releaseRule("preflight-blocked"), reason: `the release cannot land yet: ${preflight.blockers.join("; ")}` };
  if (effective.merge !== "auto") return { outcome: "gate", rule: releaseRule("owner-gate"), reason: `seat ${effective.seat} policy ${effective.merge} waits for the owner` };
  return { outcome: "allow", rule: releaseRule("version-packages"), reason: `the release preflight passed at ${headSha} for ${preflight.packages.length} public packages` };
}

function preflightAt(headSha: string, verdictFor: (headSha: string) => Verdict | undefined): ReleasePreflight | undefined {
  const verdict = verdictFor(headSha);
  const parsed = verdict?.kind === "MERGE" ? PreflightResult.safeParse((verdict.evidence as { release?: unknown } | null)?.release) : undefined;
  return parsed?.success ? parsed.data : undefined;
}

export function releaseLandOptions(effective: () => EffectivePolicy, verdictFor: (headSha: string) => Verdict | undefined): LandOptions {
  const decide = (_action: string, target?: { headSha?: string }): GateDecision => {
    const headSha = target?.headSha;
    return decideRelease(effective(), headSha, headSha === undefined ? undefined : preflightAt(headSha, verdictFor));
  };
  return { policy: { decide }, allowEvidence: (merge) => ({ release: preflightAt(merge.headSha, verdictFor) }) };
}

/** Each main push regenerates the Version Packages PR, so while one is ready the repo's other Shepherd merges wait for it to land. */
export function releaseGuard(registrations: () => ShepherdStore, now: () => number = Date.now): FreezeGuard {
  return {
    async reason(port, repo, pr) {
      const release = registrations().byBranch(repo, VERSION_PACKAGES_BRANCH);
      const ready = release?.releaseReady;
      if (!release || release.pr === null || release.pr === pr || !ready) return undefined;
      if (now() - Date.parse(ready.at) > RELEASE_FREEZE_MS) return undefined;
      const live = await port.getPr(repo, release.pr);
      if (live.state !== "open" || live.headSha !== ready.head) return undefined;
      return `the Version Packages PR #${release.pr} is ready at ${ready.head} and lands first`;
    },
  };
}
