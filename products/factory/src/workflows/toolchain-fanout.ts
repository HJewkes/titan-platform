import type { GitHubPort, RepoSlug } from "@titan-design/github";

/** titan-platform's own `.node-version`, `packageManager` and `engines.node` are canonical (TP-2121). */
export const CANONICAL_REPO: RepoSlug = "HJewkes/titan-platform";

export interface ToolchainConsumer {
  repo: RepoSlug;
  /** GitHubPort cannot list a directory, so each workflow the fanout reads is named here. */
  workflows: string[];
}

/**
 * A repo joins or leaves the fanout through a code change here, never through operator config. relay is a consumer too,
 * but its repo is private and the leak guard keeps its slug out of this public repo, so it is not listed.
 */
export const TOOLCHAIN_CONSUMERS: readonly ToolchainConsumer[] = [
  { repo: "HJewkes/active-work", workflows: [".github/workflows/ci.yml", ".github/workflows/release.yml"] },
  { repo: "HJewkes/agent-chat", workflows: [".github/workflows/ci.yml"] },
  { repo: "HJewkes/codewatch", workflows: [".github/workflows/ci.yml", ".github/workflows/release.yml"] },
  {
    repo: "HJewkes/titan-design",
    workflows: [
      ".github/workflows/ci.yml",
      ".github/workflows/mutation.yml",
      ".github/workflows/publish-review-schema.yml",
      ".github/workflows/publish.yml",
      ".github/workflows/react-next.yml",
      ".github/workflows/storybook.yml",
    ],
  },
];

export interface CanonicalToolchain {
  nodeVersion: string;
  packageManager: string;
  enginesNode: string | null;
}

export interface FetchedFile {
  path: string;
  content: string;
  blobSha: string;
}

/** A consumer's toolchain files at its default branch; a file that does not exist there is null or absent. */
export interface ConsumerFiles {
  repo: RepoSlug;
  baseBranch: string;
  nodeVersion: FetchedFile | null;
  packageJson: FetchedFile;
  workflows: FetchedFile[];
}

export interface FileEdit {
  path: string;
  content: string;
  /** The blob the edit replaces, so a write over a moved file fails; null creates the file. */
  expectedBlobSha: string | null;
}

export interface LeftAlone {
  path: string;
  line: number;
  reason: "matrix" | "reusable-workflow" | "expression";
}

export interface AdoptionPlan {
  repo: RepoSlug;
  baseBranch: string;
  branch: string;
  title: string;
  files: FileEdit[];
  leftAlone: LeftAlone[];
}

/** Reads the canonical toolchain the way `scripts/env-doctor.mjs` `readToolchain` does, from the default branch over the API. */
export async function readCanonical(port: GitHubPort): Promise<CanonicalToolchain> {
  const ref = await port.defaultBranch(CANONICAL_REPO);
  const versionFile = await port.getFile(CANONICAL_REPO, ".node-version", ref);
  const pkgFile = await port.getFile(CANONICAL_REPO, "package.json", ref);
  if (versionFile === null || pkgFile === null) throw new Error(`${CANONICAL_REPO}@${ref} has no .node-version or package.json`);
  const pkg = parsePackageJson(pkgFile);
  if (typeof pkg.packageManager !== "string") throw new Error(`${CANONICAL_REPO}@${ref} package.json has no packageManager`);
  return { nodeVersion: normalizeVersion(versionFile.content), packageManager: pkg.packageManager, enginesNode: enginesNodeOf(pkg) };
}

export async function readConsumer(port: GitHubPort, consumer: ToolchainConsumer): Promise<ConsumerFiles> {
  const { repo } = consumer;
  const baseBranch = await port.defaultBranch(repo);
  const nodeVersion = await port.getFile(repo, ".node-version", baseBranch);
  const packageJson = await port.getFile(repo, "package.json", baseBranch);
  if (packageJson === null) throw new Error(`${repo}@${baseBranch} has no package.json`);
  const workflows: FetchedFile[] = [];
  for (const path of consumer.workflows) {
    const file = await port.getFile(repo, path, baseBranch);
    if (file !== null) workflows.push(file);
  }
  return { repo, baseBranch, nodeVersion, packageJson, workflows };
}

/** The edit that aligns one consumer with the canonical toolchain, or null when it already matches. */
export function adoptionPlan(canonical: CanonicalToolchain, consumer: ConsumerFiles): AdoptionPlan | null {
  const files: FileEdit[] = [];
  const nodeVersion = nodeVersionEdit(canonical, consumer.nodeVersion);
  if (nodeVersion) files.push(nodeVersion);
  const pkg = packageJsonEdit(canonical, consumer.packageJson);
  if (pkg) files.push(pkg);
  const leftAlone: LeftAlone[] = [];
  for (const workflow of consumer.workflows) {
    const rewrite = rewriteWorkflow(workflow.content);
    leftAlone.push(...rewrite.leftAlone.map((found) => ({ path: workflow.path, ...found })));
    if (rewrite.content !== workflow.content) files.push({ path: workflow.path, content: rewrite.content, expectedBlobSha: workflow.blobSha });
  }
  if (files.length === 0) return null;
  return { repo: consumer.repo, baseBranch: consumer.baseBranch, branch: adoptionBranch(canonical), title: adoptionTitle(canonical), files, leftAlone };
}

export function adoptionBranch(canonical: CanonicalToolchain): string {
  return `toolchain/node-${canonical.nodeVersion}-${canonical.packageManager.replace("@", "-")}`;
}

function adoptionTitle(canonical: CanonicalToolchain): string {
  return `Adopt the canonical toolchain: node ${canonical.nodeVersion}, ${canonical.packageManager}`;
}

/** One line per PR the fanout would open, for `titan-factory toolchain fanout --dry-run`. */
export function dryRunLines(plans: readonly AdoptionPlan[]): string[] {
  return plans.map((plan) => {
    const files = plan.files.map((file) => file.path).join(", ");
    const left = plan.leftAlone.map((found) => `${found.path}:${found.line} (${found.reason})`).join(", ");
    return `${plan.repo}: open ${plan.branch} into ${plan.baseBranch} [${files}]${left ? `; left alone: ${left}` : ""}`;
  });
}

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePackageJson(file: { path: string; content: string }): JsonObject {
  const parsed: unknown = JSON.parse(file.content);
  if (!isJsonObject(parsed)) throw new Error(`${file.path} is not a JSON object`);
  return parsed;
}

function enginesOf(pkg: JsonObject): JsonObject {
  return isJsonObject(pkg.engines) ? pkg.engines : {};
}

function enginesNodeOf(pkg: JsonObject): string | null {
  const node = enginesOf(pkg).node;
  return typeof node === "string" ? node : null;
}

function normalizeVersion(content: string): string {
  return content.trim().replace(/^v/, "");
}

function nodeVersionEdit(canonical: CanonicalToolchain, current: FetchedFile | null): FileEdit | null {
  if (current !== null && normalizeVersion(current.content) === canonical.nodeVersion) return null;
  return { path: ".node-version", content: `${canonical.nodeVersion}\n`, expectedBlobSha: current?.blobSha ?? null };
}

function managerName(packageManager: string): string {
  return packageManager.split("@")[0]!;
}

/** A repo on another package manager (npm) keeps its own `packageManager`; only `engines.node` is aligned there. */
function packageJsonEdit(canonical: CanonicalToolchain, file: FetchedFile): FileEdit | null {
  const pkg = parsePackageJson(file);
  let changed = false;
  const current = typeof pkg.packageManager === "string" ? pkg.packageManager : null;
  if (current !== null && managerName(current) === managerName(canonical.packageManager) && current !== canonical.packageManager) {
    pkg.packageManager = canonical.packageManager;
    changed = true;
  }
  if (canonical.enginesNode !== null && enginesNodeOf(pkg) !== canonical.enginesNode) {
    pkg.engines = { ...enginesOf(pkg), node: canonical.enginesNode };
    changed = true;
  }
  if (!changed) return null;
  return { path: file.path, content: `${JSON.stringify(pkg, null, jsonIndent(file.content))}\n`, expectedBlobSha: file.blobSha };
}

function jsonIndent(content: string): string {
  return /^\{\r?\n([ \t]+)"/.exec(content)?.[1] ?? "  ";
}

interface YamlLine {
  /** Column of the mapping key, after any leading `- `. */
  column: number;
  key: string | null;
  value: string;
  sequenceItem: boolean;
}

const YAML_LINE = /^(\s*)(-\s+)?([\w.-]+):\s*(.*)$/;

function parseLine(line: string): YamlLine | null {
  if (/^\s*(#.*)?$/.test(line)) return null;
  const match = YAML_LINE.exec(line);
  if (!match) return { column: line.search(/\S/), key: null, value: line.trim(), sequenceItem: /^\s*-/.test(line) };
  return { column: match[1]!.length + (match[2]?.length ?? 0), key: match[3]!, value: match[4]!.trim(), sequenceItem: match[2] !== undefined };
}

/** Rewrites each `actions/setup-node` literal `node-version:` to `node-version-file: .node-version` and reports the rest. */
export function rewriteWorkflow(content: string): { content: string; leftAlone: Omit<LeftAlone, "path">[] } {
  const lines = content.split("\n");
  const parsed = lines.map(parseLine);
  const leftAlone: Omit<LeftAlone, "path">[] = [];
  parsed.forEach((entry, index) => {
    if (entry?.key !== "node-version") return;
    const verdict = classifyNodeVersion(parsed, index);
    if (verdict === "rewrite") lines[index] = lines[index]!.replace(/node-version:.*$/, "node-version-file: .node-version");
    else leftAlone.push({ line: index + 1, reason: verdict });
  });
  return { content: lines.join("\n"), leftAlone };
}

function classifyNodeVersion(parsed: (YamlLine | null)[], index: number): "rewrite" | LeftAlone["reason"] {
  const parentIndex = parentOf(parsed, index);
  if (parentIndex === null || parsed[parentIndex]!.key !== "with") return "matrix";
  const uses = stepUses(parsed, parentIndex);
  if (uses === null || !uses.startsWith("actions/setup-node@")) return "reusable-workflow";
  return parsed[index]!.value.includes("${{") ? "expression" : "rewrite";
}

/** The nearest earlier line whose key sits left of this one: the mapping that holds it. */
function parentOf(parsed: (YamlLine | null)[], index: number): number | null {
  const column = parsed[index]!.column;
  for (let i = index - 1; i >= 0; i--) {
    const entry = parsed[i];
    if (entry && entry.column < column) return i;
  }
  return null;
}

/** The `uses:` beside a `with:`, searched within the same step or job mapping in both directions. */
function stepUses(parsed: (YamlLine | null)[], withIndex: number): string | null {
  const column = parsed[withIndex]!.column;
  const usesAt = (entry: YamlLine) => (entry.column === column && entry.key === "uses" ? entry.value.replace(/^["']/, "") : null);
  for (let i = withIndex; i >= 0; i--) {
    const entry = parsed[i];
    if (!entry || entry.column > column) continue;
    if (entry.column < column) break;
    if (usesAt(entry) !== null) return usesAt(entry);
    if (entry.sequenceItem) break;
  }
  for (let i = withIndex + 1; i < parsed.length; i++) {
    const entry = parsed[i];
    if (!entry || entry.column > column) continue;
    if (entry.column < column || entry.sequenceItem) break;
    if (usesAt(entry) !== null) return usesAt(entry);
  }
  return null;
}
