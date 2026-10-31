import type { GitHubPort, PrFile, RepoSlug } from "@titan-design/github";
import type { StepResult, StepRoute, WorkflowContext } from "@titan-design/workflow";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { isObjectLike } from "@titan-design/rpc-protocol/narrow";
import type { StepDeclaration } from "../definition.js";
import type { GateDecision, PolicyRule } from "../gate-policy.js";
import { codeRoute, step, type LandOptions } from "../workflows/land.js";
import type { FreezeGuard } from "./freeze.js";
import type { FixTasks } from "./main-red.js";
import { isGithubPath } from "./merge-facts.js";
import type { ShepherdDeps, Verdict } from "./phases.js";
import { publishReview } from "./publish-review.js";
import type { EffectivePolicy, MergeMode } from "./policy.js";
import { RELEASE_FOLLOW_STEP, followRelease, npmVersionRegistry, type VersionRegistry } from "./release-follow.js";
import type { ShepherdStore } from "./store.js";
import { readPath } from "../narrow.js";

/** The branch the changesets action opens its "Version Packages" pull request from. */
export const VERSION_PACKAGES_BRANCH = "changeset-release/main";
/** The registration's implementer: no agent writes this PR, so a wake for it is never handled. */
export const RELEASE_IMPLEMENTER = "changesets";
export const RELEASE_PREFLIGHT_STEP = "sh-release-preflight";
export const RELEASE_STEPS: readonly StepDeclaration[] = [
  { id: RELEASE_PREFLIGHT_STEP, kind: "dispatch" },
  { id: RELEASE_FOLLOW_STEP, kind: "dispatch" },
];
/** How long a ready Version Packages head holds the repo's other Shepherd merges; a stuck release cannot hold them longer. */
export const RELEASE_FREEZE_MS = 30 * 60_000;

export function releaseTask(repo: RepoSlug): string {
  return `${repo.split("/")[1] ?? repo}/version-packages`;
}

/**
 * `missing` when npm answers 404, `trusted` when its latest version was published by a trusted publisher, `untrusted`
 * otherwise; any other answer throws. Only a trusted publisher shows that release.yml can publish the next version;
 * provenance attestations do not, because a token publish can carry them too.
 */
type NpmPresence = "missing" | "untrusted" | "trusted";
export type PackageRegistry = (name: string) => Promise<NpmPresence>;

const REGISTRY_TIMEOUT_MS = 10_000;

const LatestVersion = z.looseObject({ _npmUser: z.looseObject({ trustedPublisher: z.unknown().optional() }).optional() });
const TrustedPublisher = z.looseObject({ id: z.string().min(1) });

export function npmRegistry(fetchImpl: typeof fetch = fetch): PackageRegistry {
  return async (name) => {
    const response = await fetchImpl(`https://registry.npmjs.org/${name.replace("/", "%2f")}/latest`, { signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS) });
    if (response.status === 404) return "missing";
    if (!response.ok) throw new Error(`registry.npmjs.org answered ${response.status} for ${name}`);
    const latest = LatestVersion.parse(await response.json());
    return TrustedPublisher.safeParse(latest._npmUser?.trustedPublisher).success ? "trusted" : "untrusted";
  };
}

/** Waits before each retry of an unreadable registry; the last failure is thrown after these run out. */
export const REGISTRY_BACKOFF_MS: readonly number[] = [2_000, 4_000, 8_000];

/** A 404 answers at once; a 5xx or network failure is read again after each backoff, and only the last failure is thrown. */
export function retryingRegistry(registry: PackageRegistry, sleep: (ms: number, signal: AbortSignal) => Promise<void>, signal: AbortSignal): PackageRegistry {
  return async (name) => {
    for (const ms of REGISTRY_BACKOFF_MS) {
      try {
        return await registry(name);
      } catch {
        await sleep(ms, signal);
      }
    }
    return registry(name);
  };
}

const MANIFEST_FILE = /^(?:[^/]+\/)*package\.json$/;
const CHANGELOG_FILE = /^(?:[^/]+\/)*CHANGELOG\.md$/;
const CONSUMED_CHANGESET = /^\.changeset\/[^/]+\.md$/;
const CATALOG_FILES = new Set(["CAPABILITIES.md", "site/guides/capabilities.md"]);

/** What `pnpm version-packages` writes: bumped manifests, changelogs, the regenerated catalog, and consumed changesets. */
export function isReleaseFile(file: PrFile): boolean {
  if (isGithubPath(file.path) || file.previousPath !== undefined) return false;
  if (CONSUMED_CHANGESET.test(file.path)) return file.status === "removed";
  if (MANIFEST_FILE.test(file.path)) return file.status === "modified";
  return CHANGELOG_FILE.test(file.path) || CATALOG_FILES.has(file.path);
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
  /** The packages npm answered 404 for; each is also one of `blockers`. */
  unpublished: string[];
  /** The packages whose latest version no trusted publisher published; each is also one of `blockers`. */
  untrusted?: string[];
  /** Each public package whose version this release bumps, to its head version: what npm must serve once it publishes. */
  versions: Record<string, string>;
}

/**
 * Every public package in the release must already exist on npm with a trusted publisher, shown by its latest version,
 * because release.yml publishes through one and has no token. A registry that cannot be read throws, so no blocked
 * result is stored for a head npm never answered for.
 */
export async function releasePreflight(port: GitHubPort, registry: PackageRegistry, target: ReleaseTarget): Promise<ReleasePreflight> {
  const pr = await port.getPr(target.repo, target.pr);
  const blockers = headBlockers(target, pr.headRef, pr.headRepo, pr.headSha);
  const files = await port.listPrFiles(target.repo, target.pr);
  const foreign = files.filter((file) => !isReleaseFile(file)).map((file) => file.path);
  if (foreign.length > 0) blockers.push(`it changes files a release does not write: ${foreign.join(", ")}`);
  const manifests = await readManifests(port, target, pr.baseRef, files);
  blockers.push(...manifests.blockers, ...manifestEditBlockers(manifests.pairs));
  const packages = publicPackages(manifests.pairs);
  const { unpublished, untrusted } = await npmPresence(registry, packages);
  blockers.push(...unpublished.map((name) => `${name} is not on registry.npmjs.org yet; publish its first version by hand (CLAUDE.md, Releasing)`));
  blockers.push(...untrusted.map((name) => `${name}'s latest version on registry.npmjs.org has no trusted publisher; the owner confirms one is saved (CLAUDE.md, Releasing)`));
  return { head: target.head, blockers, packages, unpublished, ...(untrusted.length > 0 && { untrusted }), versions: bumpedVersions(manifests.pairs) };
}

async function npmPresence(registry: PackageRegistry, packages: readonly string[]): Promise<{ unpublished: string[]; untrusted: string[] }> {
  const unpublished: string[] = [];
  const untrusted: string[] = [];
  for (const name of packages) {
    const presence = await registry(name);
    if (presence === "missing") unpublished.push(name);
    if (presence === "untrusted") untrusted.push(name);
  }
  return { unpublished, untrusted };
}

function headBlockers(target: ReleaseTarget, headRef: string, headRepo: string | null, headSha: string): string[] {
  const blockers: string[] = [];
  if (headRef !== VERSION_PACKAGES_BRANCH || headRepo?.toLowerCase() !== target.repo.toLowerCase()) blockers.push(`its head is not ${VERSION_PACKAGES_BRANCH} in ${target.repo}`);
  if (headSha !== target.head) blockers.push(`its head moved from ${target.head} to ${headSha}`);
  return blockers;
}

const Manifest = z.looseObject({ name: z.string().optional(), version: z.string().optional(), private: z.boolean().optional() });
type Manifest = z.infer<typeof Manifest>;

interface ManifestPair {
  path: string;
  base: Manifest;
  head: Manifest;
}

/** Each changed manifest at the merge base and at the head; one that cannot be read blocks the release rather than failing the run. */
async function readManifests(port: GitHubPort, target: ReleaseTarget, baseRef: string, files: readonly PrFile[]): Promise<{ pairs: ManifestPair[]; blockers: string[] }> {
  const paths = files.filter((file) => file.status === "modified" && MANIFEST_FILE.test(file.path)).map((file) => file.path);
  if (paths.length === 0) return { pairs: [], blockers: [] };
  const { mergeBaseSha } = await port.compareFiles(target.repo, baseRef, target.head);
  const pairs: ManifestPair[] = [];
  const blockers: string[] = [];
  for (const path of paths) {
    const [base, head] = [await readManifest(port, target.repo, path, mergeBaseSha), await readManifest(port, target.repo, path, target.head)];
    if (base && head) pairs.push({ path, base, head });
    else blockers.push(`${path} is not a readable package manifest at ${base ? target.head : mergeBaseSha}`);
  }
  return { pairs, blockers };
}

async function readManifest(port: GitHubPort, repo: RepoSlug, path: string, ref: string): Promise<Manifest | null> {
  const read = await port.getFile(repo, path, ref);
  if (!read) return null;
  try {
    const parsed = Manifest.safeParse(JSON.parse(read.content));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const;

/** A release may change a manifest's `version`, and a dependency range only for a package this release bumps; any other edit is not changesets'. */
function manifestEditBlockers(pairs: readonly ManifestPair[]): string[] {
  const bumped = new Set(pairs.filter((pair) => pair.base.version !== pair.head.version).map((pair) => pair.head.name));
  return pairs.flatMap((pair) => {
    const edits = [...outsideDependencyEdits(pair), ...DEPENDENCY_FIELDS.flatMap((field) => dependencyEdits(pair, field, bumped))];
    return edits.length > 0 ? [`${pair.path} changes more than versions: ${edits.join(", ")}`] : [];
  });
}

function outsideDependencyEdits({ base, head }: ManifestPair): string[] {
  const keys = new Set([...Object.keys(base), ...Object.keys(head)]);
  return [...keys].filter((key) => key !== "version" && !(DEPENDENCY_FIELDS as readonly string[]).includes(key) && !isDeepStrictEqual(base[key], head[key]));
}

function dependencyEdits({ base, head }: ManifestPair, field: (typeof DEPENDENCY_FIELDS)[number], bumped: ReadonlySet<string | undefined>): string[] {
  const [from, to] = [dependencyMap(base[field]), dependencyMap(head[field])];
  if (!from || !to) return isDeepStrictEqual(base[field], head[field]) ? [] : [field];
  const names = new Set([...Object.keys(from), ...Object.keys(to)]);
  return [...names].filter((name) => from[name] !== to[name] && !(bumped.has(name) && name in from && name in to)).map((name) => `${field}.${name}`);
}

function dependencyMap(value: unknown): Record<string, unknown> | null {
  if (value === undefined) return {};
  return isObjectLike(value) && !Array.isArray(value) ? value : null;
}

function publicPackages(pairs: readonly ManifestPair[]): string[] {
  return pairs.flatMap(({ head }) => (head.private !== true && head.name !== undefined ? [head.name] : [])).sort();
}

function bumpedVersions(pairs: readonly ManifestPair[]): Record<string, string> {
  const bumped = pairs.filter(({ base, head }) => head.private !== true && head.name !== undefined && head.version !== undefined && head.version !== base.version);
  return Object.fromEntries(bumped.map(({ head }) => [head.name, head.version]));
}

interface PreflightInput extends ReleaseTarget {
  runId: string;
  merge: MergeMode;
  release?: "grant";
}

interface FollowInput {
  repo: RepoSlug;
  pr: number;
  mergeSha: string;
  runId: string;
  versions: Record<string, string>;
}

/** Marks the head ready only under an auto policy with the release-merge grant, so a release the owner must approve never holds other merges; a run not yet registered marks nothing. */
export function releaseRoutes(deps: ShepherdDeps, registry: PackageRegistry, versions: VersionRegistry = npmVersionRegistry(), tasks?: FixTasks): StepRoute[] {
  return [
    codeRoute(RELEASE_PREFLIGHT_STEP, deps.now, async (input: PreflightInput, signal) => {
      const preflight = await releasePreflight(deps.port, retryingRegistry(registry, deps.sleep, signal), input);
      const ready = preflight.blockers.length === 0 && input.merge === "auto" && input.release === "grant";
      const store = deps.store.get();
      if (store.byRun(input.runId)) store.setReleaseReady(input.runId, ready ? input.head : null);
      return preflight;
    }),
    codeRoute(RELEASE_FOLLOW_STEP, deps.now, async (input: FollowInput, signal) => {
      const task = deps.store.get().byRun(input.runId)?.task;
      return followRelease({ ...deps, registry: versions, tasks }, { ...input, task }, signal);
    }),
  ];
}

const FollowResult = z.looseObject({ outcome: z.enum(["published", "failed", "timeout", "nothing"]), versions: z.record(z.string(), z.string()), missing: z.array(z.string()), task: z.string().nullable(), detail: z.string() });

/** Follows a merged release to npm and records how it ended; a failure or timeout is the result, never a gate. */
export async function releaseFollowStep(ctx: WorkflowContext, target: { repo: RepoSlug; pr: number; mergeSha: string }, versions: Record<string, string>): Promise<z.infer<typeof FollowResult>> {
  return step(ctx, RELEASE_FOLLOW_STEP, { ...target, runId: ctx.runId, versions }, FollowResult);
}

const PreflightResult = z.looseObject({ head: z.string(), blockers: z.array(z.string()), packages: z.array(z.string()), unpublished: z.array(z.string()).default([]), versions: z.record(z.string(), z.string()).default({}) });

const NPM_BLOCKED_ROW = "Policy shepherd-release/preflight-blocked:";

/** The preflight an owner gate asks about, when packages npm had not seen are its only blockers; a hand publish can clear exactly that. */
export function blockedOnlyByNpm(stepResults: Readonly<Record<string, StepResult>>, gatePrompt: string): ReleasePreflight | undefined {
  for (const result of Object.values(stepResults)) {
    if (!result.stepId.startsWith(`${RELEASE_PREFLIGHT_STEP}:`)) continue;
    const parsed = PreflightResult.safeParse(result.data?.result);
    if (!parsed.success || !gatePrompt.includes(`at head ${parsed.data.head}`) || !gatePrompt.includes(NPM_BLOCKED_ROW)) continue;
    const { blockers, unpublished } = parsed.data;
    return unpublished.length > 0 && unpublished.length === blockers.length ? parsed.data : undefined;
  }
  return undefined;
}

/** True once npm has every package that blocked the preflight; a registry that cannot be read is asked again on the next sweep. */
export async function publishedSince(registry: PackageRegistry, preflight: ReleasePreflight): Promise<boolean> {
  try {
    for (const name of preflight.unpublished) if ((await registry(name)) === "missing") return false;
    return true;
  } catch {
    return false;
  }
}

/** The Version Packages PR is reviewed by its preflight, not by an agent: changesets wrote it, and the preflight checks exactly that. */
export async function releaseVerdict(ctx: WorkflowContext, target: ReleaseTarget, { merge, release }: Pick<EffectivePolicy, "merge" | "release">): Promise<Verdict> {
  const preflight = await step(ctx, `${RELEASE_PREFLIGHT_STEP}:${target.head}`, { ...target, runId: ctx.runId, merge, ...(release && { release }) }, PreflightResult);
  await publishReview(ctx, target, { outcome: "MERGE", verdictHead: preflight.head, head: target.head, releaseBlockers: preflight.blockers.length });
  return { kind: "MERGE", headSha: target.head, evidence: { release: preflight } };
}

const releaseRule = (rowId: string): PolicyRule => ({ table: "shepherd-release", rowId, version: 1 });

/** The release gate: a passed preflight at this exact head merges under an auto seat with the release-merge grant; every other row is the owner's. */
export function decideRelease(effective: EffectivePolicy, headSha: string | undefined, preflight: ReleasePreflight | undefined): GateDecision {
  if (effective.merge === "never") return { outcome: "deny", rule: releaseRule("never"), reason: `seat ${effective.seat} policy never allows a merge` };
  if (headSha === undefined || preflight?.head !== headSha) return { outcome: "gate", rule: releaseRule("no-preflight"), reason: `no release preflight ran at ${headSha ?? "an unknown head"}` };
  if (preflight.blockers.length > 0) return { outcome: "gate", rule: releaseRule("preflight-blocked"), reason: `the release cannot land yet: ${preflight.blockers.join("; ")}` };
  if (effective.merge !== "auto") return { outcome: "gate", rule: releaseRule("owner-gate"), reason: `seat ${effective.seat} policy ${effective.merge} waits for the owner` };
  if (effective.release !== "grant") return { outcome: "gate", rule: releaseRule("no-release-grant"), reason: `seat ${effective.seat} lacks the release-merge grant, so the release waits for the owner` };
  return { outcome: "allow", rule: releaseRule("version-packages"), reason: `the release preflight passed at ${headSha} for ${preflight.packages.length} public packages` };
}

/** The passed preflight a MERGE verdict at `headSha` carries; a merged release reads its bumped versions here. */
export function releasePreflightAt(headSha: string, verdictFor: (headSha: string) => Verdict | undefined): ReleasePreflight | undefined {
  const verdict = verdictFor(headSha);
  const parsed = verdict?.kind === "MERGE" ? PreflightResult.safeParse(readPath(verdict.evidence, "release")) : undefined;
  return parsed?.success ? parsed.data : undefined;
}

export function releaseLandOptions(effective: () => EffectivePolicy, verdictFor: (headSha: string) => Verdict | undefined): LandOptions {
  const decide = (_action: string, target?: { headSha?: string }): GateDecision => {
    const headSha = target?.headSha;
    return decideRelease(effective(), headSha, headSha === undefined ? undefined : releasePreflightAt(headSha, verdictFor));
  };
  return { policy: { decide }, allowEvidence: (merge) => ({ release: releasePreflightAt(merge.headSha, verdictFor) }) };
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
