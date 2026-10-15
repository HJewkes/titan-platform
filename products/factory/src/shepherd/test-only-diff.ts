import { CONFIG_PATH, planFixProof, testOnlyOf } from "@titan-design/fix-proof";
import { PR_FILES_CAP, type GitHubPort, type PrFile, type RepoSlug } from "@titan-design/github";
import { failureOf } from "./error-class.js";

/** Whether a PR's diff touches only tests, carried files, mutation specs and changesets; anything not read in full is `unread`. */
export type TestOnlyDiff = { kind: "test-only" } | { kind: "source"; paths: readonly string[] } | { kind: "unread"; reason: string };

// GitHub reports no similarity score; the plan reads a score only to skip pure test renames, never to sort source.
const NAME_STATUS: ReadonlyMap<string, string> = new Map([
  ["added", "A"],
  ["removed", "D"],
  ["modified", "M"],
  ["changed", "T"],
  ["copied", "C050"],
  ["renamed", "R050"],
]);
// A tab or newline in a path would split the synthesized name-status line, so such a list is refused rather than parsed.
const hasControlChar = (path: string): boolean => [...path].some((char) => char < " " || char === "\u007f");

function nameStatusLine(file: PrFile): string | undefined {
  const code = NAME_STATUS.get(file.status);
  if (code === undefined) return undefined;
  const paired = code.length > 1;
  if (paired !== (file.previousPath !== undefined)) return undefined;
  const paths = paired ? [file.previousPath ?? "", file.path] : [file.path];
  if (paths.some(hasControlChar)) return undefined;
  return [code, ...paths].join("\t");
}

/** The PR's file list as `git diff --name-status`, so Shepherd and the CI plan share one definition of test-only. */
function nameStatusOf(files: readonly PrFile[]): { text: string } | { unread: string } {
  const lines: string[] = [];
  for (const file of files) {
    const line = nameStatusLine(file);
    if (line === undefined) return { unread: `the PR's changed file ${JSON.stringify(file.path)} (${file.status}) cannot be classified` };
    lines.push(line);
  }
  return { text: lines.join("\n") };
}

async function readFiles(port: GitHubPort, repo: RepoSlug, pr: number): Promise<PrFile[] | { unread: string }> {
  try {
    const files = await port.listPrFiles(repo, pr);
    if (files.length >= PR_FILES_CAP) return { unread: `the PR changes ${files.length} files, at GitHub's ${PR_FILES_CAP}-file list cap` };
    return files;
  } catch (error) {
    return { unread: `the PR's changed files could not be read: ${failureOf(error)}` };
  }
}

const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/**
 * A stacked PR's base is a parent PR's branch, which any agent can push to, so only a PR based on the default branch is
 * classified. Its merge base with the default branch is owner-reviewed history; the branch tip may have moved past it.
 */
async function trustedBase(port: GitHubPort, repo: RepoSlug, pr: number): Promise<{ sha: string } | { unread: string }> {
  const { baseRef, headSha } = await port.getPr(repo, pr);
  const defaultBranch = await port.defaultBranch(repo);
  if (baseRef !== defaultBranch) {
    return { unread: `the PR's base ${JSON.stringify(baseRef)} is not the default branch ${JSON.stringify(defaultBranch)}, so its ${CONFIG_PATH} is not trusted` };
  }
  const { mergeBaseSha } = await port.compareFiles(repo, defaultBranch, headSha);
  if (!SHA.test(mergeBaseSha)) return { unread: `the merge base of ${JSON.stringify(defaultBranch)} and the PR's head is not a commit sha` };
  return { sha: mergeBaseSha };
}

/** The config's globs come from the default branch's merge base, never the PR's head or base branch, so no PR can widen what counts as a test. */
async function readTrustedConfig(port: GitHubPort, repo: RepoSlug, pr: number): Promise<{ text: string | null } | { unread: string }> {
  try {
    const base = await trustedBase(port, repo, pr);
    if ("unread" in base) return base;
    const file = await port.getFile(repo, CONFIG_PATH, base.sha);
    return { text: file?.content ?? null };
  } catch (error) {
    return { unread: `${CONFIG_PATH} could not be read at the default branch's merge base: ${failureOf(error)}` };
  }
}

/** Classifies the PR's diff; every read error, a list at the file cap, a harness path or an unparseable entry fails closed. */
export async function testOnlyDiff(port: GitHubPort, repo: RepoSlug, pr: number | null): Promise<TestOnlyDiff> {
  if (pr === null) return { kind: "unread", reason: "the registration names no PR, so its changed files are unknown" };
  const files = await readFiles(port, repo, pr);
  if ("unread" in files) return { kind: "unread", reason: files.unread };
  if (files.length === 0) return { kind: "unread", reason: "the PR lists no changed files" };
  const nameStatus = nameStatusOf(files);
  if ("unread" in nameStatus) return { kind: "unread", reason: nameStatus.unread };
  const config = await readTrustedConfig(port, repo, pr);
  if ("unread" in config) return { kind: "unread", reason: config.unread };
  const planned = planFixProof({ nameStatus: nameStatus.text, baseConfig: config.text });
  if (!planned.ok) return { kind: "unread", reason: `the PR's diff could not be planned: ${planned.error}` };
  return testOnlyOf(planned.plan) ? { kind: "test-only" } : { kind: "source", paths: planned.plan.source };
}
