import { CHANGESET_GLOB, compileGlobs } from "@titan-design/fix-proof";
import { PR_FILES_CAP, latestPerName, type CheckRun, type GitHubPort, type PrFile, type RepoSlug, type RequiredChecks } from "@titan-design/github";
import { z } from "zod";
import { readBaseRequiredChecks } from "../required-checks.js";
import { generatedPathsFor } from "./remerge-carry.js";

const WORKFLOWS = ".github/workflows/";

const CitationSchema = z.object({ name: z.string(), sha: z.string(), runId: z.number().nullable(), conclusion: z.string().nullable() });
/** One required check's newest run at one commit; a context with no run there cites a null run and conclusion. */
type CiCitation = z.infer<typeof CitationSchema>;

export const WorkflowCiReadSchema = z.looseObject({
  kind: z.literal("workflow-ci"),
  proved: z.boolean(),
  head: z.string(),
  mergeBase: z.string(),
  /** The base branch whose required checks and merge base the read judged; absent on a read recorded before the field. */
  baseRef: z.string().optional(),
  base: z.array(CitationSchema),
  atHead: z.array(CitationSchema),
  reason: z.string(),
});
/**
 * The proof for a diff no unit test can cover: CI itself. `proved` is set when a required check concluded failure at the merge base
 * and every required check concluded success at the head.
 */
export type WorkflowCiRead = z.infer<typeof WorkflowCiReadSchema>;

/** Changesets and the repo's declared generated files ride along with a workflow edit; anything else makes the diff mixed. */
function isWorkflowOnly(repo: RepoSlug, files: readonly PrFile[]): boolean {
  const alongside = compileGlobs([CHANGESET_GLOB, ...generatedPathsFor(repo)]);
  const paths = files.flatMap((file) => [file.path, file.previousPath ?? file.path]);
  const workflow = (path: string) => path.startsWith(WORKFLOWS);
  return paths.some(workflow) && paths.every((path) => workflow(path) || alongside(path));
}

/** Any file list that cannot be read in full leaves the diff to the fix-proof run, as before. */
async function workflowOnlyDiff(port: GitHubPort, repo: RepoSlug, pr: number): Promise<boolean> {
  try {
    const files = await port.listPrFiles(repo, pr);
    return files.length < PR_FILES_CAP && isWorkflowOnly(repo, files);
  } catch {
    return false;
  }
}

/** A pinned context counts only runs from its pinned apps, as the merge rule does. */
function citeAt(runs: readonly CheckRun[], sha: string, checks: RequiredChecks): CiCitation[] {
  return checks.contexts.map((name) => {
    const pins = checks.pins?.[name];
    const counts = (candidate: CheckRun) => pins === undefined || (candidate.appId !== null && pins.includes(candidate.appId));
    const run = latestPerName(runs.filter((candidate) => candidate.name === name && candidate.headSha === sha && counts(candidate)))[0];
    return { name, sha, runId: run?.id ?? null, conclusion: run?.status === "completed" ? run.conclusion : null };
  });
}

const cited = (citations: readonly CiCitation[]): string => citations.map((c) => `${c.name} ${c.conclusion ?? "no result"}${c.runId === null ? "" : ` (run ${c.runId})`}`).join(", ");

function verdictOf(head: string, baseRef: string, mergeBase: string, base: CiCitation[], atHead: CiCitation[]): WorkflowCiRead {
  const proved = base.some((c) => c.conclusion === "failure") && atHead.every((c) => c.conclusion === "success");
  const facts = `the PR changes only ${WORKFLOWS}; required checks at the merge base ${mergeBase}: ${cited(base)}; at the head ${head}: ${cited(atHead)}`;
  const outcome = proved ? "CI proves the change" : "CI proves nothing unless a required check failed at the merge base and every one passed at the head";
  return { kind: "workflow-ci", proved, head, baseRef, mergeBase, base, atHead, reason: `${facts}; ${outcome}` };
}

/**
 * The CI proof for a PR whose diff is only workflows, or undefined when the diff is anything else or the PR's head is no longer
 * `head`. A read that fails throws, so the caller records it as an error read. `bound` judges that base instead of the PR's live
 * one, and the read names the base it judged either way.
 */
export async function workflowCiProof(port: GitHubPort, repo: RepoSlug, pr: number | null, head: string, bound?: string): Promise<WorkflowCiRead | undefined> {
  if (pr === null || !(await workflowOnlyDiff(port, repo, pr))) return undefined;
  const live = await port.getPr(repo, pr);
  if (live.headSha !== head) return undefined;
  const baseRef = bound ?? live.baseRef;
  const required = await readBaseRequiredChecks(port, repo, baseRef);
  if (!required.readable) throw new Error(required.reason);
  const { mergeBaseSha } = await port.compareFiles(repo, baseRef, head);
  if (required.checks.contexts.length === 0) return verdictOf(head, baseRef, mergeBaseSha, [], []);
  const [baseRuns, headRuns] = await Promise.all([port.checkRuns(repo, mergeBaseSha), port.checkRuns(repo, head)]);
  return verdictOf(head, baseRef, mergeBaseSha, citeAt(baseRuns, mergeBaseSha, required.checks), citeAt(headRuns, head, required.checks));
}
