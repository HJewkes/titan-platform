import { z } from "zod";
import type { JudgeControl, JudgeItem, PlannedItem } from "./batch.js";
import { pickJudges, type JudgeQuestion } from "./core.js";

export const REAL = "real";
export const NOT_REAL = "not-real";

/** One blocking finding with what the judge may see of it: the review, the diff and the lines it cites. */
interface FaFinding {
  key: string;
  review: string;
  /** Absent for a review that cites no verifiable line: the whole review is then the finding. */
  cite?: Cite;
  citedLines: string;
  diff: string;
}

interface Cite {
  path: string;
  lineStart: number;
  lineEnd: number;
}

const NO_CITATION = "The review cites no verifiable line.";

const INSTRUCTIONS = [
  "A code reviewer blocked a change. You are checking one of its blocking findings against the change itself.",
  "Judge only from the texts below: the review, the diff of the change, and the head lines the finding cites.",
  "A finding is real when the defect it describes exists in the code at this head; a plausible-sounding claim the code does not bear out is not real.",
].join(" ");

function faQuestion(finding: FaFinding): JudgeQuestion {
  const { cite } = finding;
  const where = cite === undefined ? undefined : `${cite.path}:${cite.lineStart}-${cite.lineEnd}`;
  const subject = where === undefined ? "any blocking finding in this review" : `this blocking finding (the one citing ${where})`;
  const scope = where === undefined ? "The review cites no verifiable line, so judge its blocking findings as a whole." : `The finding under judgment is the blocking finding in the review that cites ${where}.`;
  return {
    instructions: `${INSTRUCTIONS}\n\n${scope}`,
    criteria: [{ id: "real", ask: `Is ${subject} a real defect at this head? Quote the line that settles it.` }],
    labels: [REAL, NOT_REAL],
    decisive: "real",
    texts: { review: finding.review, diff: finding.diff, "cited-lines": finding.citedLines },
  };
}

const faItem = (finding: FaFinding): JudgeItem => ({ key: finding.key, questions: [faQuestion(finding)] });

const ControlSchema = z.strictObject({
  key: z.string().min(1),
  expected: z.enum([REAL, NOT_REAL]),
  review: z.string().min(1),
  path: z.string().min(1),
  lineStart: z.number().int().positive(),
  lineEnd: z.number().int().positive(),
  citedLines: z.string(),
  diff: z.string(),
});

/** R controls: (a) a planted-defect finding, expected real; (b) a fabricated claim on an unchanged line, expected not real. */
export function parseFaControls(json: unknown): JudgeControl[] {
  return z
    .array(ControlSchema)
    .min(1)
    .parse(json)
    .map(({ expected, path, lineStart, lineEnd, ...rest }) => ({ ...faItem({ ...rest, cite: { path, lineStart, lineEnd } }), expected }));
}

const Cited = z.looseObject({ path: z.string(), lineStart: z.number().int().positive(), lineEnd: z.number().int().positive() });
const ScoreRow = z.looseObject({
  arm: z.string(),
  caseId: z.string(),
  attempt: z.number().int(),
  result: z.looseObject({ caseType: z.string(), falseAlarm: z.boolean().optional(), cited: z.array(Cited).optional() }),
});
const JobRef = z.looseObject({ arm: z.looseObject({ id: z.string(), model: z.string() }), caseId: z.string(), attempt: z.number().int(), sessionId: z.string() });

/** Where the false-alarm judge reads a job's output and its case bundle. */
export interface FaSource {
  review: (sessionId: string) => string;
  diff: (caseId: string) => string;
  headLines: (caseId: string, path: string) => readonly string[];
}

/** The cited line range as the judge reads it, headed by its path. */
export function citedLines(lines: readonly string[], path: string, start: number, end: number): string {
  return [`${path} lines ${start}-${end}:`, ...lines.slice(start - 1, end)].join("\n");
}

/** Every verified citation of a false alarm on a clean case, keyed arm:case:index; a false alarm citing nothing is one whole-review item at index 0. */
export function falseAlarmItems(scoreRows: readonly unknown[], jobRows: readonly unknown[], source: FaSource): PlannedItem[] {
  const jobs = jobRows.flatMap((row) => {
    const parsed = JobRef.safeParse(row);
    return parsed.success ? [parsed.data] : [];
  });
  return scoreRows.flatMap((raw) => {
    const row = ScoreRow.safeParse(raw);
    if (!row.success || row.data.result.caseType !== "clean" || row.data.result.falseAlarm !== true) return [];
    const { arm, caseId, attempt } = row.data;
    const job = jobs.find((entry) => entry.arm.id === arm && entry.caseId === caseId && entry.attempt === attempt);
    if (job === undefined) throw new Error(`no job row for ${arm} on ${caseId} attempt ${attempt}`);
    const judges = pickJudges([job.arm.model]);
    const review = source.review(job.sessionId);
    const diff = source.diff(caseId);
    const cited = row.data.result.cited ?? [];
    if (cited.length === 0) return [{ item: faItem({ key: `${arm}:${caseId}:0`, review, citedLines: NO_CITATION, diff }), judges }];
    return cited.map((cite, index) => {
      const finding = { key: `${arm}:${caseId}:${index}`, review, cite, diff, citedLines: citedLines(source.headLines(caseId, cite.path), cite.path, cite.lineStart, cite.lineEnd) };
      return { item: faItem(finding), judges };
    });
  });
}
