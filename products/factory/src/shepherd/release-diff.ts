import type { GitHubPort, PrFile, RepoSlug } from "@titan-design/github";
import { isObjectLike } from "@titan-design/rpc-protocol/narrow";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { isGithubPath } from "./ci-policy-read.js";

/** The branch the changesets action opens its "Version Packages" pull request from. */
export const VERSION_PACKAGES_BRANCH = "changeset-release/main";

/** A PR at one head; manifests are read at its merge base with `baseRef` and at `head`. */
interface ReleaseDiffTarget {
  repo: RepoSlug;
  head: string;
}

const MANIFEST_FILE = /^(?:[^/]+\/)*package\.json$/;
const CHANGELOG_FILE = /^(?:[^/]+\/)*CHANGELOG\.md$/;
const CONSUMED_CHANGESET = /^\.changeset\/[^/]+\.md$/;
const CATALOG_FILES = new Set(["CAPABILITIES.md", "site/guides/capabilities.md"]);

/**
 * What `pnpm version-packages` writes: bumped manifests, changelogs, the regenerated catalog, and consumed changesets.
 * GitHub reports a type or mode change, a symlink swap among them, as `changed`, which no release writes. A release
 * adds a CHANGELOG.md only beside a manifest it bumps, so an added one needs its directory's package.json modified.
 */
function isReleaseFile(file: PrFile, bumpedManifests: ReadonlySet<string>): boolean {
  if (isGithubPath(file.path) || file.previousPath !== undefined) return false;
  if (CONSUMED_CHANGESET.test(file.path)) return file.status === "removed";
  if (MANIFEST_FILE.test(file.path)) return file.status === "modified";
  if (CATALOG_FILES.has(file.path)) return file.status === "modified" || file.status === "added";
  if (!CHANGELOG_FILE.test(file.path)) return false;
  return file.status === "modified" || (file.status === "added" && bumpedManifests.has(siblingManifest(file.path)));
}

function siblingManifest(path: string): string {
  return path.replace(/CHANGELOG\.md$/, "package.json");
}

/** The PR's files `pnpm version-packages` would not write; empty means the diff is release-only. */
export function nonReleaseFiles(files: readonly PrFile[]): PrFile[] {
  const bumped = new Set(files.filter((file) => file.status === "modified" && file.previousPath === undefined && MANIFEST_FILE.test(file.path)).map((file) => file.path));
  return files.filter((file) => !isReleaseFile(file, bumped));
}

const Manifest = z.looseObject({ name: z.string().optional(), version: z.string().optional(), private: z.boolean().optional() });
type Manifest = z.infer<typeof Manifest>;

export interface ManifestPair {
  path: string;
  base: Manifest;
  head: Manifest;
}

/** Each changed manifest at the merge base and at the head; one that cannot be read blocks the release rather than failing the run. */
export async function readManifests(port: GitHubPort, target: ReleaseDiffTarget, baseRef: string, files: readonly PrFile[]): Promise<{ pairs: ManifestPair[]; blockers: string[] }> {
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
export function manifestEditBlockers(pairs: readonly ManifestPair[]): string[] {
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

/**
 * True when `files` are only what `pnpm version-packages` writes, and each manifest, parsed at the merge base and at `head`,
 * changes only its version and the ranges of packages this release bumps (TP-6767). Such a diff changes no code, so the
 * G10 touch classes its paths fall under are moot. A list, manifest or merge base that cannot be read is false.
 */
export async function versionOnlyDiff(port: GitHubPort, target: ReleaseDiffTarget & { baseRef: string }, files: readonly PrFile[]): Promise<boolean> {
  if (files.length === 0 || nonReleaseFiles(files).length > 0) return false;
  try {
    const manifests = await readManifests(port, target, target.baseRef, files);
    return manifests.blockers.length === 0 && manifestEditBlockers(manifests.pairs).length === 0;
  } catch {
    return false;
  }
}
