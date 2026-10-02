import { dataFence } from "@titan-design/agent-dispatch";
import { isPassing, type CheckRun, type GitHubPort, type PullRequest, type RepoSlug } from "@titan-design/github";
import { z } from "zod";
import { DEFECT_CLASS_HEADING } from "./reviewer-brief.js";

/** Recorded once per FIX_FIRST wake, so the run's count of them survives a replay and a new head. */
export const FIX_FIRST_STEP = "sh-wake-fix-first";
/** The FIX_FIRST at which the fixer gets a structural brief instead of another patch round. */
export const STRUCTURAL_FIX_FIRST = 2;
export const LOG_TAIL_LINES = 150;
/** The most CI log the wake carries across every failing job, headers included. */
export const LOG_BUDGET_BYTES = 8 * 1024;

/** Files a build regenerates from source; a conflict confined to them is settled by regenerating, never by hand-merging. */
const REGISTRY_FILES: ReadonlySet<string> = new Set(["CAPABILITIES.md", "site/.vitepress/reference-sidebar.json", "site/guides/capabilities.md", ".codewatch/check.json"]);
const REGISTRY_DIR = "site/reference/";
export const isRegistry = (path: string): boolean => REGISTRY_FILES.has(path) || (path.startsWith(REGISTRY_DIR) && path.length > REGISTRY_DIR.length);

/** What a wake is about: the brief reads nothing else. */
export interface WakeFacts {
  kind: "ci-red" | "review" | "conflict" | "fix-proof";
  repo: string;
  pr: number;
  headSha: string;
  payload: unknown;
  /** Which FIX_FIRST of the run a review wake is, from 1; absent reads as the first. */
  fixFirst?: number;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The failing jobs' log tails, split evenly so one noisy job cannot crowd out the rest. */
async function ciLogs(port: GitHubPort, input: WakeFacts): Promise<string> {
  const failing = (await port.latestCheckRuns(input.repo, input.headSha)).filter((run) => run.status === "completed" && !isPassing(run));
  if (failing.length === 0) return "No failing check run was found at this head.";
  const budget = Math.floor((LOG_BUDGET_BYTES - (failing.length - 1)) / failing.length);
  const sections = await Promise.all(failing.map((run) => logSection(port, input.repo, run, budget)));
  return headBytes(sections.join("\n"), LOG_BUDGET_BYTES);
}

async function logSection(port: GitHubPort, repo: RepoSlug, run: CheckRun, budget: number): Promise<string> {
  const header = `== ${run.name} (${run.conclusion ?? "no conclusion"}) ${run.url}\n`;
  const log = run.workflowRunId === null ? "(not an Actions job, so no log is read)" : await port.jobLogTail(repo, run.id, LOG_TAIL_LINES).catch((error: unknown) => `(log unavailable: ${messageOf(error)})`);
  return header + tailBytes(log, Math.max(0, budget - Buffer.byteLength(header)));
}

/** The last `max` bytes, dropping a character the cut split; a log's error is at its end. */
export function tailBytes(text: string, max: number): string {
  const bytes = Buffer.from(text);
  if (bytes.length <= max) return text;
  return bytes.subarray(bytes.length - max).toString("utf8").replace(/^�+/, "");
}

function headBytes(text: string, max: number): string {
  const bytes = Buffer.from(text);
  if (bytes.length <= max) return text;
  return bytes.subarray(0, max).toString("utf8").replace(/�+$/, "");
}

interface Conflict {
  /** Files the PR changed that the base also changed since the merge base: the likely conflicts. */
  files: string[];
  truncated: boolean;
}

async function conflictFiles(port: GitHubPort, input: WakeFacts, pr: PullRequest): Promise<Conflict> {
  const [prFiles, base] = await Promise.all([port.listPrFiles(input.repo, input.pr), port.compareFiles(input.repo, input.headSha, pr.baseRef)]);
  const moved = new Set(base.files);
  const touched = prFiles.flatMap((file) => [file.path, ...(file.previousPath === undefined ? [] : [file.previousPath])]);
  return { files: [...new Set(touched.filter((path) => moved.has(path)))], truncated: base.truncated };
}

/** A truncated comparison may hide a hand-written file, so it is never generated-only. */
const generatedOnly = (conflict: Conflict): boolean => !conflict.truncated && conflict.files.length > 0 && conflict.files.every(isRegistry);

function conflictList(conflict: Conflict): string {
  const mark = !generatedOnly(conflict) && conflict.files.some(isRegistry);
  const files = conflict.files.map((path) => (mark && isRegistry(path) ? `${path} (generated registry)` : path));
  const lines = files.length > 0 ? files : ["No file both this PR and the base changed; rebase and resolve what git reports."];
  return [...lines, ...(conflict.truncated ? ["GitHub truncated the base comparison, so this list may be missing files."] : [])].join("\n");
}

const REGENERATE = "run `pnpm build` then `pnpm capabilities`, commit the regenerated files and push";

function conflictReason(input: WakeFacts, conflict: Conflict): string {
  const intro = `Head ${input.headSha} conflicts with its base branch, named in the fence below.`;
  if (generatedOnly(conflict)) {
    return `${intro} The conflict is generated-only: every file both sides changed is a generated registry. Merge the base branch from origin, take the base's side of those files, ${REGENERATE}. Do not hand-merge them.`;
  }
  const registries = conflict.files.some(isRegistry) ? ` Do not hand-merge a file marked (generated registry): take the base's side of it, then ${REGENERATE}.` : "";
  return `${intro} The files both sides changed follow.${registries}`;
}

const FixFirst = z.looseObject({ text: z.string().min(1) });
const VERDICT_LINE = /^\s*(?:Verdict|PR|Head):/;
const isDefectHeading = (line: string): boolean => line.replace(/^[\s#*]+/, "").toLowerCase().startsWith(DEFECT_CLASS_HEADING.toLowerCase());

/** The reviewer's defect-class section, from its heading to the verdict block; undefined when the reviewer wrote none. */
export function defectClassSection(text: string): string | undefined {
  const lines = text.split("\n");
  const start = lines.findIndex(isDefectHeading);
  if (start < 0) return undefined;
  const end = lines.findIndex((line, index) => index > start && VERDICT_LINE.test(line));
  return lines.slice(start, end < 0 ? undefined : end).join("\n").trim();
}

function ordinal(n: number): string {
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `${n}${suffix}`;
}

const STRUCTURAL = "Do not patch the items one by one: fix the defect class at the one boundary where a single change covers every instance, then check that each blocking item in the findings is covered by it.";
const NO_CLASS = "The reviewer named no defect class. Name the class these items share and the boundary where one fix covers it in your final message, then fix it there.";

/** A repeat FIX_FIRST carries the reviewer's defect class and the findings whole, so no blocking item is summarised away. */
function reviewWake(input: WakeFacts): { reason: string; payload: string } {
  const text = FixFirst.parse(input.payload).text;
  const nth = input.fixFirst ?? 1;
  const findings = dataFence("review findings", text);
  if (nth < STRUCTURAL_FIX_FIRST) return { reason: `An independent review of head ${input.headSha} returned FIX_FIRST. Its findings follow.`, payload: findings };
  const section = defectClassSection(text);
  const intro = `An independent review of head ${input.headSha} returned FIX_FIRST, the ${ordinal(nth)} on this PR, so this is a structural pass. ${STRUCTURAL}`;
  const reason = `${intro} ${section === undefined ? NO_CLASS : "The reviewer's defect class follows, then every blocking item verbatim in the full findings."}`;
  return { reason, payload: section === undefined ? findings : `${dataFence("defect class", section)}\n\n${findings}` };
}

/** Why the agent is woken, and the data that shows it, fenced. */
export async function describeWake(port: GitHubPort, input: WakeFacts, pr: PullRequest): Promise<{ reason: string; payload: string }> {
  const head = input.headSha;
  switch (input.kind) {
    case "ci-red":
      return { reason: `CI failed at head ${head}. The failing jobs' log tails follow.`, payload: dataFence("CI log", await ciLogs(port, input)) };
    case "review":
      return reviewWake(input);
    case "conflict": {
      const conflict = await conflictFiles(port, input, pr);
      return { reason: conflictReason(input, conflict), payload: `${dataFence("base branch", pr.baseRef)}\n\n${dataFence("conflict candidates", conflictList(conflict))}` };
    }
    case "fix-proof":
      return { reason: `The fix-proof check at head ${head} did not pass. Its result follows.`, payload: dataFence("fix-proof result", JSON.stringify(input.payload ?? null, null, 2)) };
  }
}
