import { CONFIG_PATH, planFixProof, testOnlyReading, type TestOnlyReading } from "@titan-design/fix-proof";
import { PR_FILES_CAP, type GitHubPort, type PrFile, type RepoSlug } from "@titan-design/github";
import { failureOf } from "./error-class.js";

/**
 * Whether a PR's diff touches only tests, carried files, mutation specs and changesets. A diff that deletes a test or changes
 * none is `flagged`; anything not read in full is `unread`.
 */
export type TestOnlyDiff =
  | { kind: "test-only" }
  | { kind: "source"; paths: readonly string[] }
  | { kind: "flagged"; reason: string; paths: readonly string[] }
  | { kind: "unread"; reason: string };

/** Each probe is one contents call, so a diff naming more paths is unread before any call is made. */
export const MAX_PROBED_PATHS = 100;
const PROBE_BATCH = 10;

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
 * classified. Its merge base with the default branch is owner-reviewed history, but the author picks it by branching from any old commit.
 */
type TrustedRefs = { mergeBase: string; tip: string; headSha: string };

async function trustedBase(port: GitHubPort, repo: RepoSlug, pr: number, expectedHead: string | undefined): Promise<TrustedRefs | { unread: string }> {
  const { baseRef, headSha } = await port.getPr(repo, pr);
  if (expectedHead !== undefined && headSha !== expectedHead) return { unread: `the PR's head is ${headSha}, not the ${expectedHead} under judgement` };
  const defaultBranch = await port.defaultBranch(repo);
  if (baseRef !== defaultBranch) {
    return { unread: `the PR's base ${JSON.stringify(baseRef)} is not the default branch ${JSON.stringify(defaultBranch)}, so its ${CONFIG_PATH} is not trusted` };
  }
  const { mergeBaseSha } = await port.compareFiles(repo, defaultBranch, headSha);
  if (!SHA.test(mergeBaseSha)) return { unread: `the merge base of ${JSON.stringify(defaultBranch)} and the PR's head is not a commit sha` };
  if (!SHA.test(headSha)) return { unread: "the PR's head is not a commit sha" };
  return { mergeBase: mergeBaseSha, tip: defaultBranch, headSha };
}

/**
 * The config at the merge base and at the default branch's tip, never the PR's head or base branch. An old fork point may
 * predate the config or hold wider globs, so the diff must be test-only under both; neither read alone can widen the result.
 */
async function readTrustedConfigs(port: GitHubPort, repo: RepoSlug, pr: number, expectedHead: string | undefined): Promise<{ texts: (string | null)[]; refs: TrustedRefs } | { unread: string }> {
  try {
    const refs = await trustedBase(port, repo, pr, expectedHead);
    if ("unread" in refs) return refs;
    const files = await Promise.all([refs.mergeBase, refs.tip].map((ref) => port.getFile(repo, CONFIG_PATH, ref)));
    return { texts: files.map((file) => file?.content ?? null), refs };
  } catch (error) {
    return { unread: `${CONFIG_PATH} could not be read at the default branch's merge base and tip: ${failureOf(error)}` };
  }
}

const pathsFor = (readings: readonly TestOnlyReading[], reason: "source" | "deletes-tests"): string[] =>
  [...new Set(readings.flatMap((reading) => (!reading.testOnly && reading.reason === reason ? reading.paths : [])))].sort();

/** The strictest of the readings: test-only only when every one says so, each refusal's paths the union across them. */
function strictest(readings: readonly TestOnlyReading[]): TestOnlyDiff {
  const source = pathsFor(readings, "source");
  if (source.length > 0) return { kind: "source", paths: source };
  const deleted = pathsFor(readings, "deletes-tests");
  if (deleted.length > 0) return { kind: "flagged", reason: `the PR deletes tests ${deleted.join(", ")}`, paths: deleted };
  if (readings.length > 0 && readings.every((reading) => reading.testOnly)) return { kind: "test-only" };
  return { kind: "flagged", reason: "the PR adds or changes no test", paths: [] };
}

/** Plans the diff under each config and reads each plan; a plan error under any config makes the diff unread. */
function classify(nameStatus: string, configs: readonly (string | null)[]): TestOnlyDiff {
  const readings: TestOnlyReading[] = [];
  for (const baseConfig of configs) {
    const planned = planFixProof({ nameStatus, baseConfig });
    if (!planned.ok) return { kind: "unread", reason: `the PR's diff could not be planned: ${planned.error}` };
    readings.push(testOnlyReading(planned.plan));
  }
  return strictest(readings);
}

type Probe = { path: string; ref: string };

/** A removed path or a rename's old path lives at the merge base the PR's file list diffs against; every other path at the head. */
function probesOf(files: readonly PrFile[], refs: TrustedRefs): Probe[] {
  return files.flatMap((file) => {
    if (file.status === "removed") return [{ path: file.path, ref: refs.mergeBase }];
    const head = { path: file.path, ref: refs.headSha };
    return file.status === "renamed" && file.previousPath !== undefined ? [{ path: file.previousPath, ref: refs.mergeBase }, head] : [head];
  });
}

const readsInline = (port: GitHubPort, repo: RepoSlug, probe: Probe): Promise<boolean> =>
  port.getFile(repo, probe.path, probe.ref).then(
    (file) => file !== null,
    () => false,
  );

/**
 * A path name says nothing of what it holds: a gitlink under a carry glob pins other code. GitHub returns only a regular
 * file's blob inline, so any path whose blob does not come back that way names the reason the diff is unread.
 */
async function unreadBlob(port: GitHubPort, repo: RepoSlug, files: readonly PrFile[], refs: TrustedRefs): Promise<string | undefined> {
  const probes = probesOf(files, refs);
  if (probes.length > MAX_PROBED_PATHS) return `the PR names ${probes.length} paths, over the ${MAX_PROBED_PATHS} whose blobs Shepherd reads`;
  for (let start = 0; start < probes.length; start += PROBE_BATCH) {
    const batch = probes.slice(start, start + PROBE_BATCH);
    const inline = await Promise.all(batch.map((probe) => readsInline(port, repo, probe)));
    const missing = batch.find((_, index) => !inline[index]);
    if (missing) return `${JSON.stringify(missing.path)} at ${missing.ref} is not a regular file GitHub returns inline: a gitlink, a large file or a read error`;
  }
  return undefined;
}

/**
 * Classifies the PR's diff at `expectedHead`, the immutable head under judgement: a PR whose head has moved is unread, since a gate decided
 * from a moving ref could be replayed against a head it never classified. Undefined pins nothing and is for a caller that holds no head.
 * Every read error, a list at the file cap, a harness path, an unparseable entry or a blob not read inline fails closed. */
export async function testOnlyDiff(port: GitHubPort, repo: RepoSlug, pr: number | null, expectedHead: string | undefined): Promise<TestOnlyDiff> {
  if (pr === null) return { kind: "unread", reason: "the registration names no PR, so its changed files are unknown" };
  const files = await readFiles(port, repo, pr);
  if ("unread" in files) return { kind: "unread", reason: files.unread };
  if (files.length === 0) return { kind: "unread", reason: "the PR lists no changed files" };
  const nameStatus = nameStatusOf(files);
  if ("unread" in nameStatus) return { kind: "unread", reason: nameStatus.unread };
  const configs = await readTrustedConfigs(port, repo, pr, expectedHead);
  if ("unread" in configs) return { kind: "unread", reason: configs.unread };
  const diff = classify(nameStatus.text, configs.texts);
  if (diff.kind !== "test-only") return diff;
  const unread = await unreadBlob(port, repo, files, configs.refs);
  return unread === undefined ? diff : { kind: "unread", reason: unread };
}
