import type { BundleGit } from "../../review-pr/bundle.js";
import type { PlanCase } from "./cases.js";

export const REFERENCE_MAX_TOKENS = 30_000;
/** Code tokenizes denser than prose; three characters a token keeps the estimate on the safe side of the cap. */
const CHARS_PER_TOKEN = 3;

export const estimateTokens = (text: string): number => Math.ceil(text.length / CHARS_PER_TOKEN);

const TEST_PATH = [/\.(test|spec)\.[^/]+$/, /(^|\/)(__tests__|__fixtures__|__snapshots__|test|tests|fixtures)\//, /(^|\/)test-fixtures?\.[^/]+$/];

export const isTestPath = (path: string): boolean => TEST_PATH.some((pattern) => pattern.test(path));

/** Splits a unified diff into per-file chunks and keeps the ones whose new path is not a test file. */
export function nonTestDiff(diff: string): string {
  const chunks = diff.split(/^(?=diff --git )/m).filter((chunk) => chunk.startsWith("diff --git "));
  return chunks.filter((chunk) => !isTestPath(/^diff --git a\/.* b\/(.*)$/m.exec(chunk)?.[1] ?? "")).join("");
}

/** Cuts at a line boundary so the whole text, marker included, stays within the token cap. */
export function cutToTokens(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) return text;
  const marker = "\n[reference cut here: the rest of the merged diff is over the size cap]\n";
  const room = maxTokens * CHARS_PER_TOKEN - marker.length;
  const head = text.slice(0, Math.max(0, room));
  const lineEnd = head.lastIndexOf("\n");
  return `${lineEnd > 0 ? head.slice(0, lineEnd) : head}${marker}`;
}

const gitText = async (git: BundleGit, args: readonly string[]): Promise<string> => (await git.git(args)).toString("utf8");

/**
 * What landed, for the judge only: PR titles, each PR's `--stat`, and its non-test source diff. It is built from the
 * clone at judge time and never written into a job workspace, so no arm can read it.
 */
export async function buildReference(git: BundleGit, landed: PlanCase["landed"], maxTokens = REFERENCE_MAX_TOKENS): Promise<string> {
  const stats: string[] = [];
  const diffs: string[] = [];
  for (const { mergeSha, title } of landed) {
    const range = [`${mergeSha}^1`, mergeSha];
    stats.push(`### ${title}\n${(await gitText(git, ["diff", "--stat=200", ...range])).trimEnd()}`);
    diffs.push(nonTestDiff(await gitText(git, ["diff", "--no-color", "--no-ext-diff", ...range])));
  }
  const text = [
    `PR titles:\n${landed.map(({ title }) => `- ${title}`).join("\n")}`,
    `Diff stat per PR:\n${stats.join("\n\n")}`,
    `Merged diff of non-test source:\n${diffs.join("")}`,
  ].join("\n\n");
  return cutToTokens(text, maxTokens);
}
