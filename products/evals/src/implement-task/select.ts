import { z } from "zod";
import { sha256Hex } from "../hash.js";

/** Only the fields the selector and the writer read; the v3 corpus carries ~70 more, all ignored. */
const CorpusV3RowSchema = z.object({
  case_id: z.string().min(1),
  repo: z.string().min(1),
  pr_number: z.number().int().positive(),
  base_commit: z.string().regex(/^[0-9a-f]{40}$/),
  merge_commit: z.string().regex(/^[0-9a-f]{40}$/),
  class: z.string().min(1),
  n_tasks: z.number().int().nonnegative(),
  task_ids: z.array(z.string()),
  task: z.object({ id: z.string(), initiative: z.string() }).nullable(),
  title: z.string(),
  brief_text: z.string().nullable(),
  follow_up_fixes: z.array(z.number().int()),
});

export type CorpusV3Row = z.infer<typeof CorpusV3RowSchema>;

type SkipReason =
  | "private-repo"
  | "unsupported-runner"
  | "class-not-requested"
  | "tangled"
  | "test-only"
  | "no-test-change"
  | "brief-leak";

/** What the accepted diff changed, as fix-proof's plan sorts it: tests plus source, tests alone, or no test. */
export type TestChange = "tests-and-source" | "test-only" | "no-test-change";

/** Facts that need the repo's clone; the export answers them with git and planFixProof. */
export interface CandidateFacts {
  hasSupportedLock(row: CorpusV3Row): Promise<boolean>;
  mergeParents(row: CorpusV3Row): Promise<number>;
  testChange(row: CorpusV3Row): Promise<TestChange>;
}

export interface SelectOptions {
  /** Engineering repo allowlist, bare names; the exclusion policy's `repos`. */
  repos: readonly string[];
  classes: readonly string[];
  seed: string;
}

interface Selection {
  /** Per requested class, candidates in seeded order; the export screens from the front until the quota fills. */
  byClass: Record<string, CorpusV3Row[]>;
  skipped: { caseId: string; reason: SkipReason }[];
}

const repoName = (repo: string): string => repo.slice(repo.lastIndexOf("/") + 1);

/** One row per line; a malformed line aborts the read with its 1-based number, so a bad corpus is never half-used. */
export function parseCorpusV3(text: string): CorpusV3Row[] {
  const rows: CorpusV3Row[] = [];
  text.split("\n").forEach((line, index) => {
    if (line.trim() === "") return;
    const parsed = CorpusV3RowSchema.safeParse(parseJson(line));
    if (!parsed.success) throw new Error(`corpus line ${index + 1}: ${parsed.error.issues[0]?.message ?? "invalid row"}`);
    rows.push(parsed.data);
  });
  return rows;
}

function parseJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

/** A task-file brief is the task's title and done_when; a subject-only row has its PR title. */
export const briefOf = (row: CorpusV3Row): string => row.brief_text ?? row.title;

/** A brief edited after the merge can name the answer: the PR number, the merge sha, or where it landed. */
export function leaksAnswer(brief: string, row: Pick<CorpusV3Row, "pr_number" | "merge_commit">): boolean {
  if (new RegExp(`#${row.pr_number}(?!\\d)`).test(brief)) return true;
  if (brief.toLowerCase().includes(row.merge_commit.slice(0, 7))) return true;
  return /\blanded in\b/i.test(brief);
}

/** Row-only checks run first so a skipped row costs no git call. */
function rowSkip(row: CorpusV3Row, options: SelectOptions): SkipReason | undefined {
  if (!options.repos.includes(repoName(row.repo))) return "private-repo";
  if (!options.classes.includes(row.class)) return "class-not-requested";
  if (row.n_tasks > 1) return "tangled";
  if (leaksAnswer(briefOf(row), row)) return "brief-leak";
  return undefined;
}

async function factSkip(row: CorpusV3Row, facts: CandidateFacts): Promise<SkipReason | undefined> {
  if (!(await facts.hasSupportedLock(row))) return "unsupported-runner";
  if ((await facts.mergeParents(row)) > 1) return "tangled";
  const change = await facts.testChange(row);
  return change === "tests-and-source" ? undefined : change;
}

/** A seeded hash, as in review-pr's split: the order is stable for a seed and a new seed reshuffles it. */
const drawOf = (seed: string, caseId: string): string => sha256Hex(`${seed}\0${caseId}`);

export async function selectCandidates(rows: readonly CorpusV3Row[], options: SelectOptions, facts: CandidateFacts): Promise<Selection> {
  const byClass: Record<string, CorpusV3Row[]> = Object.fromEntries(options.classes.map((cls) => [cls, []]));
  const skipped: Selection["skipped"] = [];
  for (const row of rows) {
    const reason = rowSkip(row, options) ?? (await factSkip(row, facts));
    if (reason === undefined) byClass[row.class]?.push(row);
    else skipped.push({ caseId: row.case_id, reason });
  }
  for (const pool of Object.values(byClass)) {
    pool.sort((a, b) => drawOf(options.seed, a.case_id).localeCompare(drawOf(options.seed, b.case_id)));
  }
  return { byClass, skipped };
}
