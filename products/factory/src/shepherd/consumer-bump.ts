import { createHash } from "node:crypto";
import { findNodeAtLocation, parseTree } from "jsonc-parser";
import type { GitHubPort, RepoFile, RepoSlug } from "@titan-design/github";
import { parse as parseYaml, parseAllDocuments } from "yaml";
import { z } from "zod";
import { manifestPins, pinReaches, record, workspacePins, type OverridePin } from "./consumer-bump-pins.js";
import type { Registration } from "./store.js";

export const BUMP_BRANCH_PREFIX = "shepherd/bump-consumers-";
/** Room left in agent-chat's 64-character peer name for a fixer's `-s<k>` suffix. */
const BUMP_IMPLEMENTER_MAX = 56;

const peerSlug = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/**
 * The registered implementer of one bump run. Each run needs its own: a fixer is named `<implementer>-s<k>`, and a
 * lineage takes in every roster row of that shape, so a shared name would hand one PR's wake to another PR's fixer.
 * The owner is in the name, and a name the slug cut or changed carries a hash of the whole `owner/name#pr`, so no two
 * runs share one.
 */
export function consumerBumpImplementer(repo: RepoSlug, pr: number): string {
  const slug = peerSlug(repo);
  const suffix = `-${pr}`;
  const plain = `bump-${slug}${suffix}`;
  if (slug === repo.toLowerCase().replace("/", "-") && plain.length <= BUMP_IMPLEMENTER_MAX) return plain;
  const hash = `-${createHash("sha256").update(`${repo.toLowerCase()}#${pr}`).digest("hex").slice(0, 8)}`;
  return `bump-${slug.slice(0, BUMP_IMPLEMENTER_MAX - "bump-".length - hash.length - suffix.length).replace(/-+$/, "")}${hash}${suffix}`;
}

/** A run the consumer bump sweep registered: its bump branch, and the implementer name only the sweep gives it. */
export function isConsumerBumpRun(registration: Pick<Registration, "repo" | "pr" | "branch" | "implementer">): boolean {
  const { repo, pr, branch, implementer } = registration;
  return pr !== null && branch?.startsWith(BUMP_BRANCH_PREFIX) === true && implementer === consumerBumpImplementer(repo, pr);
}
const DEP_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const;
/** A name outside this shape never reaches the registry URL or a regex. */
const TITAN_NAME = /^@titan-design\/[a-z0-9][a-z0-9._-]*$/;
const PLAIN_VERSION = /^\d+\.\d+\.\d+$/;
const BUMPABLE = /^([\^~]?)(\d+\.\d+\.\d+)$/;
const REGISTRY_TIMEOUT_MS = 10_000;

/** npm's `latest` version for a name, null when npm answers 404; any other answer throws. */
export type LatestRegistry = (name: string) => Promise<string | null>;

const LatestManifest = z.looseObject({ version: z.string() });

export function npmLatest(fetchImpl: typeof fetch = fetch): LatestRegistry {
  return async (name) => {
    const response = await fetchImpl(`https://registry.npmjs.org/${name.replace("/", "%2f")}/latest`, { signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS) });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`registry.npmjs.org answered ${response.status} for ${name}`);
    return LatestManifest.parse(await response.json()).version;
  };
}

type LockfileKind = "pnpm" | "npm";

/** What a lockfile-only install needs from a consumer at one ref; a file that is not there is null. */
export interface ConsumerTree {
  repo: RepoSlug;
  ref: string;
  /** The root `package.json` first, then each workspace manifest the lockfile names, by path. */
  manifests: RepoFile[];
  lockfile: { kind: LockfileKind; file: RepoFile } | null;
  workspaceYaml: RepoFile | null;
  npmrc: RepoFile | null;
  /** The patch files the root `pnpm.patchedDependencies` and pnpm-workspace.yaml `patchedDependencies` name; one that is not in the repo is absent. */
  patches: RepoFile[];
}

export async function readConsumerTree(port: GitHubPort, repo: RepoSlug, ref: string): Promise<ConsumerTree> {
  const root = await requiredFile(port, repo, "package.json", ref);
  const lockfile = await readLockfile(port, repo, ref);
  const manifests = [root];
  for (const dir of lockfile ? workspaceDirs(lockfile) : []) manifests.push(await requiredFile(port, repo, `${dir}/package.json`, ref));
  const workspaceYaml = await port.getFile(repo, "pnpm-workspace.yaml", ref);
  const npmrc = await port.getFile(repo, ".npmrc", ref);
  const patches = await readPatches(port, repo, ref, root, workspaceYaml);
  return { repo, ref, manifests, lockfile, workspaceYaml, npmrc, patches };
}

const PatchedDependencies = z.record(z.string(), z.string()).optional();

async function readPatches(port: GitHubPort, repo: RepoSlug, ref: string, root: RepoFile, workspaceYaml: RepoFile | null): Promise<RepoFile[]> {
  const fromRoot = z.looseObject({ pnpm: z.looseObject({ patchedDependencies: PatchedDependencies }).optional() }).parse(JSON.parse(root.content)).pnpm?.patchedDependencies;
  const fromWorkspace = workspaceYaml ? z.looseObject({ patchedDependencies: PatchedDependencies }).nullable().parse(parseYaml(workspaceYaml.content))?.patchedDependencies : undefined;
  const paths = [...new Set([...Object.values(fromRoot ?? {}), ...Object.values(fromWorkspace ?? {})])].sort();
  const patches: RepoFile[] = [];
  for (const path of paths) {
    if (path.startsWith("/") || path.split("/").some((part) => part === ".." || part === "" || part === ".")) throw new Error(`patchedDependencies names ${JSON.stringify(path)} outside the repo`);
    const patch = await port.getFile(repo, path, ref);
    if (patch !== null) patches.push(patch);
  }
  return patches;
}

async function requiredFile(port: GitHubPort, repo: RepoSlug, path: string, ref: string): Promise<RepoFile> {
  const file = await port.getFile(repo, path, ref);
  if (file === null) throw new Error(`${repo}@${ref} has no ${path}`);
  return file;
}

async function readLockfile(port: GitHubPort, repo: RepoSlug, ref: string): Promise<ConsumerTree["lockfile"]> {
  const pnpm = await port.getFile(repo, "pnpm-lock.yaml", ref);
  if (pnpm) return { kind: "pnpm", file: pnpm };
  const npm = await port.getFile(repo, "package-lock.json", ref);
  return npm ? { kind: "npm", file: npm } : null;
}

/** Workspace directories other than the root, from pnpm `importers` keys or npm `packages` keys outside node_modules. */
function workspaceDirs(lockfile: NonNullable<ConsumerTree["lockfile"]>): string[] {
  const keys = lockfile.kind === "pnpm" ? pnpmImporters(lockfile.file.content) : Object.keys(npmPackages(lockfile.file.content));
  const dirs = keys.filter((key) => key !== "" && key !== "." && !key.includes("node_modules/"));
  for (const dir of dirs) if (dir.startsWith("/") || dir.split("/").some((part) => part === ".." || part === "")) throw new Error(`lockfile names workspace ${JSON.stringify(dir)} outside the repo`);
  return [...new Set(dirs)].sort();
}

/** pnpm 10 can put a config document ahead of the lockfile proper, so every document is searched. */
function pnpmImporters(text: string): string[] {
  for (const doc of parseAllDocuments(text)) {
    const value: unknown = "toJS" in doc ? doc.toJS() : null;
    const importers = z.looseObject({ importers: z.record(z.string(), z.unknown()) }).safeParse(value);
    if (importers.success) return Object.keys(importers.data.importers);
  }
  return [];
}

function npmPackages(text: string): Record<string, unknown> {
  return z.looseObject({ packages: z.record(z.string(), z.unknown()).default({}) }).parse(JSON.parse(text)).packages;
}

interface SpecifierEdit {
  path: string;
  /** The dependency field the edit lands in. */
  field: string;
  name: string;
  from: string;
  to: string;
  /** The bare version `to` raises the dependency to. */
  version: string;
}

export interface LeftAlone {
  path: string;
  name: string;
  spec: string;
  reason: string;
}

interface FileEdit {
  path: string;
  content: string;
  /** The blob the edit replaces, so a write over a moved file fails. */
  expectedBlobSha: string;
}

export interface ConsumerBumpPlan {
  edits: SpecifierEdit[];
  files: FileEdit[];
  leftAlone: LeftAlone[];
}

/** Every `@titan-design/*` name the tree's manifests depend on or pin by override, sorted, for the caller to look up with `npmLatest`. */
export function consumerDepNames(tree: ConsumerTree): string[] {
  const names = [...tree.manifests.flatMap((file) => titanDeps(file).map(([name]) => name)), ...treePins(tree).map(({ name }) => name).filter((name) => TITAN_NAME.test(name))];
  return [...new Set(names)].sort();
}

function treePins(tree: ConsumerTree): OverridePin[] {
  return [...tree.manifests.flatMap((file) => manifestPins(parseManifest(file), file.path)), ...workspacePins(tree.workspaceYaml)];
}

/**
 * `latest` maps a name to npm's latest version, null for a 404; a name it lacks is left alone.
 * Only `dependencies`, `devDependencies`, `optionalDependencies` and `peerDependencies` are bumped: a pair under
 * `pnpm.overrides`, `overrides` or `resolutions` is never bumped, and is listed in `leftAlone` as pinned by that field.
 */
export function planConsumerBump(tree: ConsumerTree, latest: ReadonlyMap<string, string | null>): ConsumerBumpPlan {
  const plan: ConsumerBumpPlan = { edits: [], files: [], leftAlone: [] };
  const workspace = workspacePins(tree.workspaceYaml);
  plan.leftAlone.push(...pinsLeftAlone(workspace, latest));
  // Package managers read overrides and resolutions only from the root manifest and apply them to every workspace package.
  const [root] = tree.manifests;
  const rootPins = root ? manifestPins(parseManifest(root), root.path) : [];
  for (const file of tree.manifests) {
    const pins = file === root ? rootPins : manifestPins(parseManifest(file), file.path);
    const { edits, leftAlone } = decideFile(file, latest, [...pins, ...rootPins, ...workspace]);
    plan.leftAlone.push(...pinsLeftAlone(pins, latest), ...leftAlone);
    const edited = applyEdits(file, edits);
    plan.edits.push(...edited.applied);
    plan.leftAlone.push(...edited.missed);
    if (edited.content !== file.content) plan.files.push({ path: file.path, content: edited.content, expectedBlobSha: file.blobSha });
  }
  return plan;
}

/** A pin already at npm latest costs nothing to leave, so only a pin behind latest, or one that cannot be compared, is listed. */
function pinsLeftAlone(pins: OverridePin[], latest: ReadonlyMap<string, string | null>): LeftAlone[] {
  const seen = new Map<string, LeftAlone>();
  for (const { name, spec, field, path, unreadable } of pins) {
    if (unreadable) {
      seen.set(`${path}\0${name}\0${field}`, { path, name, spec, reason: `${field} key not readable as a package selector` });
      continue;
    }
    if (!TITAN_NAME.test(name) || decide(spec, latest.get(name)) === null) continue;
    seen.set(`${path}\0${name}\0${spec}\0${field}`, { path, name, spec, reason: `pinned by ${field}` });
  }
  return [...seen.values()];
}

function decideFile(file: RepoFile, latest: ReadonlyMap<string, string | null>, pins: OverridePin[]): Pick<ConsumerBumpPlan, "edits" | "leftAlone"> {
  const edits: SpecifierEdit[] = [];
  const leftAlone: LeftAlone[] = [];
  for (const [field, name, spec] of titanDepEntries(file)) {
    const pinned = pins.find((pin) => pin.name === name && pinReaches(pin, spec));
    const decision = pinned === undefined ? decide(spec, latest.get(name)) : { reason: `pinned by ${pinned.field}` };
    if (decision === null) continue;
    if ("reason" in decision) leftAlone.push({ path: file.path, name, spec, reason: decision.reason });
    else edits.push({ path: file.path, field, name, from: spec, ...decision });
  }
  return { edits, leftAlone };
}

function parseManifest(file: RepoFile): Map<string, unknown> {
  try {
    return new Map(record(JSON.parse(file.content)));
  } catch {
    throw new Error(`${file.path} is not valid JSON`);
  }
}

/** Titan dependency pairs as `[field, name, spec]`. */
function titanDepEntries(file: RepoFile): [string, string, string][] {
  const fields = parseManifest(file);
  return DEP_FIELDS.flatMap((field) =>
    record(fields.get(field)).flatMap(([name, spec]): [string, string, string][] => (TITAN_NAME.test(name) && typeof spec === "string" ? [[field, name, spec]] : [])),
  );
}

export function titanDeps(file: RepoFile): [string, string][] {
  return titanDepEntries(file).map(([, name, spec]) => [name, spec]);
}

type Decision = { to: string; version: string } | { reason: string } | null;

/** Null means the dependency is already on (or past) latest. */
function decide(spec: string, latest: string | null | undefined): Decision {
  const unsupported = unsupportedSpec(spec);
  if (unsupported) return { reason: unsupported };
  if (latest === undefined) return { reason: "latest version not read" };
  if (latest === null) return { reason: "not on npm" };
  if (!PLAIN_VERSION.test(latest)) return { reason: `npm latest ${latest} is not a plain x.y.z` };
  const [, prefix = "", current = ""] = BUMPABLE.exec(spec) ?? [];
  return compareVersions(current, latest) < 0 ? { to: `${prefix}${latest}`, version: latest } : null;
}

function unsupportedSpec(spec: string): string | null {
  if (BUMPABLE.test(spec)) return null;
  const protocol = /^([a-z][a-z+-]*):/i.exec(spec)?.[1];
  if (protocol) return `${protocol}: specifier`;
  if (/\s|\|\|/.test(spec)) return "compound range";
  if (/^[a-z][\w.-]*$/i.test(spec)) return "dist-tag";
  return "unsupported range";
}

/** Numeric per part, so 0.10.0 sorts above 0.9.0; both sides are plain x.y.z. */
function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return (left[i] ?? 0) - (right[i] ?? 0);
  return 0;
}

/** Replaces each dependency's value node found by its `[field, name]` path, so no other node moves and formatting and key order survive. */
function applyEdits(file: RepoFile, edits: SpecifierEdit[]): { content: string; applied: SpecifierEdit[]; missed: LeftAlone[] } {
  let content = file.content;
  const applied: SpecifierEdit[] = [];
  const missed: LeftAlone[] = [];
  for (const edit of edits) {
    const node = findNodeAtLocation(parseTree(content) ?? { type: "null", offset: 0, length: 0 }, [edit.field, edit.name]);
    if (node?.type !== "string" || node.value !== edit.from) {
      missed.push({ path: edit.path, name: edit.name, spec: edit.from, reason: "pair not written literally" });
      continue;
    }
    content = `${content.slice(0, node.offset)}${JSON.stringify(edit.to)}${content.slice(node.offset + node.length)}`;
    applied.push(edit);
  }
  return { content, applied, missed };
}

/** One branch per release set: a rerun of the same set lands on it, a newer release gets a new one. */
export function bumpBranch(edits: readonly Pick<SpecifierEdit, "name" | "version">[]): string {
  const set = [...new Set(edits.map(({ name, version }) => `${name}@${version}`))].sort();
  return `${BUMP_BRANCH_PREFIX}${createHash("sha256").update(set.join("\n")).digest("hex").slice(0, 8)}`;
}
