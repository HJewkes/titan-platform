import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { MAX_REVIEWER_QUESTIONS, reviewerBrief, type ReviewerBriefInput } from "./reviewer-brief.js";

/** The part of a review target the report is looked up by. */
interface CodewatchTarget {
  repo: string;
  head: string;
}

const CODEWATCH_REPORT_SCHEMA = "codewatch-pr-report@1";
const CODEWATCH_ARTIFACT = "codewatch-report";
/** The rest of the brief's question cap belongs to the TP-540 question bank. */
export const MAX_CODEWATCH_QUESTIONS = 3;

/** Recorded on the sh-review step. `schema` is the report's own value when it has one, so a wrong schema is visible. */
export interface CodewatchEvidence {
  found: boolean;
  schema: string | null;
  questions: number;
  warning?: string;
}

interface CodewatchQuestions {
  questions: readonly string[];
  evidence: CodewatchEvidence;
}

/** The parsed JSON of the head's `codewatch-report` artifact; undefined when the head has none. */
export type FetchCodewatchReport = (target: CodewatchTarget) => Promise<unknown>;

/** Answers undefined for a repo that publishes no report, so its review records nothing. */
export type CodewatchReader = (target: CodewatchTarget) => Promise<CodewatchQuestions | undefined>;

const ReportSchema = z.looseObject({ schema: z.literal(CODEWATCH_REPORT_SCHEMA), questions: z.array(z.string()) });

const absent = (warning?: string, schema: string | null = null): CodewatchQuestions => ({ questions: [], evidence: { found: false, schema, questions: 0, ...(warning && { warning }) } });

function fromReport(raw: unknown): CodewatchQuestions {
  const parsed = ReportSchema.safeParse(raw);
  if (!parsed.success) {
    const schema = typeof raw === "object" && raw !== null && "schema" in raw && typeof raw.schema === "string" ? raw.schema : null;
    return absent(`codewatch report is not ${CODEWATCH_REPORT_SCHEMA}: ${parsed.error.issues[0]?.message ?? "invalid"}`, schema);
  }
  const questions = parsed.data.questions.slice(0, MAX_CODEWATCH_QUESTIONS);
  return { questions, evidence: { found: true, schema: parsed.data.schema, questions: questions.length } };
}

/** The report is advisory: a missing artifact, a wrong schema or a failed fetch gives no questions, and the review proceeds. */
export function codewatchReader(fetchReport: FetchCodewatchReport, repos: readonly string[]): CodewatchReader {
  const covered = new Set(repos.map((repo) => repo.toLowerCase()));
  return async (target) => {
    if (!covered.has(target.repo.toLowerCase())) return undefined;
    try {
      const raw = await fetchReport(target);
      return raw === undefined ? absent() : fromReport(raw);
    } catch (error) {
      return absent(`codewatch report fetch failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
}

/** Codewatch questions go first; the bank fills what is left of the brief's cap. */
export function briefQuestions(codewatch: readonly string[], bank: readonly string[]): string[] {
  return [...codewatch.slice(0, MAX_CODEWATCH_QUESTIONS), ...bank].slice(0, MAX_REVIEWER_QUESTIONS);
}

type BriefTarget = Omit<ReviewerBriefInput, "questions">;

/** The reviewer brief with the codewatch questions ahead of the bank's, and the evidence the sh-review step records. */
export async function reviewBrief(input: BriefTarget, codewatch?: CodewatchReader, bank?: (target: BriefTarget) => Promise<readonly string[]>): Promise<{ brief: string; codewatch?: CodewatchEvidence }> {
  const report = await codewatch?.(input);
  const questions = briefQuestions(report?.questions ?? [], (await bank?.(input)) ?? []);
  return { brief: reviewerBrief({ ...input, questions }), ...(report && { codewatch: report.evidence }) };
}

const run = promisify(execFile);
const ArtifactList = z.object({ artifacts: z.array(z.object({ expired: z.boolean(), workflow_run: z.object({ id: z.number(), head_sha: z.string() }).nullable() })) });

/** Reads the artifact through the `gh` CLI: the newest unexpired `codewatch-report` whose workflow run is at the head. */
export function ghCodewatchReport(gh = "gh"): FetchCodewatchReport {
  return async ({ repo, head }) => {
    const { stdout } = await run(gh, ["api", `repos/${repo}/actions/artifacts?name=${CODEWATCH_ARTIFACT}&per_page=100`]);
    const artifact = ArtifactList.parse(JSON.parse(stdout)).artifacts.find((a) => !a.expired && a.workflow_run?.head_sha === head);
    if (!artifact?.workflow_run) return undefined;
    const dir = await mkdtemp(join(tmpdir(), "codewatch-report-"));
    try {
      await run(gh, ["run", "download", String(artifact.workflow_run.id), "--repo", repo, "--name", CODEWATCH_ARTIFACT, "--dir", dir]);
      return JSON.parse(await readFile(join(dir, `${CODEWATCH_ARTIFACT}.json`), "utf8"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
}
