import { readFileSync } from "node:fs";
import { z } from "zod";
import { evalVersion, readRubric } from "./eval-evidence.js";
import { JudgeConfigSchema, judgeLabel, type JudgeConfig, type JudgeHarness, type JudgeReply } from "./eval-harness.js";
import { spokenText } from "./lint-register.js";
import type { GateRow } from "./writing-gate.js";
import type { GateSeverity } from "./writing-gate-policy.js";
import { verifyMarks, verifyTerms, type PlacedMark, type PlacedTerm } from "./writing-judge-verify.js";

const WRITING_JUDGE_EVAL_ID = "writing-judge";

/**
 * A known-bad paragraph on an unrelated subject, put after the piece: three naming sentences in one shape. A judge
 * that marks none of it is not trusted, and its marks never count toward the rate.
 */
const CANARY =
  "The wheel at the back of a bicycle carries a stack of toothed rings. That is called the cassette. A small arm pushes the chain from ring to ring. That is called the derailleur. The ring at the pedals pulls the chain round. That is called the chainring.";

/** The judge's config plus the extractor's model; with none named, the extractor runs on the judge's model. */
export const WritingJudgeConfigSchema = JudgeConfigSchema.extend({ extractor_model: z.string().min(1).optional() });
export type WritingJudgeConfig = z.infer<typeof WritingJudgeConfigSchema>;

const severity = z.enum(["error", "warning", "report-only"]);
const JudgedPolicySchema = z.object({
  minWords: z.number().int().positive(),
  judged: z.object({
    "hallmark-marks": z.object({ severity, warnAbove: z.number().nonnegative(), errorAbove: z.number().nonnegative() }),
    "words-per-term": z.object({ severity, floor: z.number().positive(), allowTerms: z.number().int().nonnegative() }),
    "terms-first-400": z.object({ severity, window: z.number().int().positive() }),
  }),
});
export type JudgedPolicy = z.infer<typeof JudgedPolicySchema>;

let shippedPolicy: JudgedPolicy | undefined;
const judgedPolicy = (): JudgedPolicy =>
  (shippedPolicy ??= JudgedPolicySchema.parse(JSON.parse(readFileSync(new URL("../doctrine/writing-gate.json", import.meta.url), "utf8"))));

export interface WritingRubrics {
  judge: string;
  checklist: string;
  extract: string;
}

const shippedRubrics = (): WritingRubrics => ({
  judge: readRubric("writing-hallmark-judge.md"),
  checklist: readRubric("writing-hallmark-checklist.json"),
  extract: readRubric("writing-terms-extract.md"),
});

const ChecklistSchema = z.array(z.object({ id: z.string(), question: z.string() }));
const MarksSchema = z.object({ marks: z.array(z.object({ id: z.string(), quote: z.string(), why: z.string() })) });
const TermsSchema = z.object({
  terms: z.array(z.object({ term: z.string(), first_mention: z.string(), definition: z.string().nullable(), motivation: z.string().nullable(), used_after: z.boolean() })),
});

interface WritingJudgeInput {
  beats: readonly { id: string; spoken: string }[];
  config: WritingJudgeConfig;
  harnessFor: (config: JudgeConfig) => JudgeHarness;
  policy?: JudgedPolicy;
  rubrics?: WritingRubrics;
}

export interface WritingJudgeResult {
  eval_version: string;
  judge: string;
  extractor: string;
  trusted: boolean;
  failures: string[];
  canary_marks: number;
  dropped: { marks: number; terms: number };
  terms: string[];
  spend: { usd: number; tokensIn: number; tokensOut: number };
  rows: GateRow[];
}

const configs = ({ extractor_model, ...judge }: WritingJudgeConfig): { judge: JudgeConfig; extractor: JudgeConfig } => ({
  judge,
  extractor: { ...judge, model: extractor_model ?? judge.model },
});

/** The rubrics, both models and the canary: any of them changing starts a new eval_version. */
export const writingJudgeVersion = (rubrics: WritingRubrics, config: WritingJudgeConfig): string =>
  evalVersion(WRITING_JUDGE_EVAL_ID, `${rubrics.judge}\n${rubrics.checklist}\n${rubrics.extract}`, configs(config).judge, { canary: CANARY, extractor: configs(config).extractor.model });

const fill = (template: string, slots: Record<string, string>): string =>
  Object.entries(slots).reduce((text, [slot, value]) => text.replace(`{{${slot}}}`, () => value), template);

/** Each beat's spoken text as one paragraph, and where each beat starts in the joined piece. */
function pieceOf(beats: WritingJudgeInput["beats"]): { text: string; starts: { id: string; at: number }[] } {
  const paragraphs = beats.map((beat) => ({ id: beat.id, text: spokenText([beat.spoken]).text })).filter((p) => p.text !== "");
  const starts = paragraphs.map((p, i) => ({ id: p.id, at: paragraphs.slice(0, i).reduce((at, q) => at + q.text.length + 2, 0) }));
  return { text: paragraphs.map((p) => p.text).join("\n\n"), starts };
}

const spendOf = (replies: readonly JudgeReply<unknown>[]) => ({
  usd: replies.reduce((sum, r) => sum + r.usd, 0),
  tokensIn: replies.reduce((sum, r) => sum + r.tokensIn, 0),
  tokensOut: replies.reduce((sum, r) => sum + r.tokensOut, 0),
});

interface Measured {
  words: number;
  marks: PlacedMark[] | null;
  terms: PlacedTerm[] | null;
}

/** Marked passages per 1,000 words: past the error line fails at the row's severity, past the warning line warns, and an unmeasured rate fails. */
function marksRow({ words, marks }: Measured, rule: JudgedPolicy["judged"]["hallmark-marks"], beatAt: (offset: number) => string): GateRow {
  const passages = marks === null ? null : [...new Map(marks.map((m) => [`${m.start}:${m.end}`, m])).values()].sort((a, b) => a.start - b.start);
  const value = passages === null ? null : (1000 * passages.length) / Math.max(words, 1);
  const level: GateSeverity = value !== null && value <= rule.errorAbove ? "warning" : rule.severity;
  const failing = rule.severity !== "report-only" && (value === null || value > rule.warnAbove);
  const beats = failing && passages !== null ? [...new Set(passages.map((p) => beatAt(p.start)))] : [];
  return { id: "writing:hallmark-marks", value, threshold: rule.errorAbove, severity: failing ? level : rule.severity, pass: !failing, beats };
}

function wordsPerTermRow({ words, terms }: Measured, rule: JudgedPolicy["judged"]["words-per-term"]): GateRow {
  const value = terms === null ? null : words / Math.max(terms.length, 1);
  const fails = value === null || (terms !== null && terms.length > rule.allowTerms && value < rule.floor);
  return { id: "writing:words-per-term", value, threshold: rule.floor, severity: rule.severity, pass: rule.severity === "report-only" || !fails, beats: [] };
}

function firstWindowRow({ terms }: Measured, rule: JudgedPolicy["judged"]["terms-first-400"]): GateRow {
  const value = terms === null ? null : terms.filter((term) => term.atWord < rule.window).length;
  return { id: "writing:terms-first-400", value, threshold: rule.window, severity: rule.severity, pass: true, beats: [] };
}

/** The judged rows; under the policy's minimum words each only reports, as every writing gate row does. */
function judgedRows(measured: Measured, policy: JudgedPolicy, beatAt: (offset: number) => string): GateRow[] {
  const rows = [marksRow(measured, policy.judged["hallmark-marks"], beatAt), wordsPerTermRow(measured, policy.judged["words-per-term"]), firstWindowRow(measured, policy.judged["terms-first-400"])];
  return measured.words < policy.minWords ? rows.map((row) => ({ ...row, severity: "report-only", pass: true, beats: [] })) : rows;
}

async function askBoth(input: WritingJudgeInput, rubrics: WritingRubrics, text: string) {
  const { judge, extractor } = configs(input.config);
  const checklist = ChecklistSchema.parse(JSON.parse(rubrics.checklist)).map((item) => `- ${item.id}: ${item.question}`).join("\n");
  const judgePrompt = fill(rubrics.judge, { checklist, piece: `${text}\n\n${CANARY}` });
  return Promise.all([
    input.harnessFor(judge)({ prompt: judgePrompt, schema: MarksSchema }),
    input.harnessFor(extractor)({ prompt: fill(rubrics.extract, { piece: text }), schema: TermsSchema }),
  ]);
}

/**
 * One hallmark-judge call (with the canary after the piece) and one term-extractor call. Quotes are verified against
 * the piece; a failed call or an unmarked canary leaves the marks and words-per-term rows unmeasured, which fails them at
 * their severity.
 */
export async function runWritingJudge(input: WritingJudgeInput): Promise<WritingJudgeResult> {
  const rubrics = input.rubrics ?? shippedRubrics();
  const { text, starts } = pieceOf(input.beats);
  const [marksReply, termsReply] = await askBoth(input, rubrics, text);
  const known = new Set(ChecklistSchema.parse(JSON.parse(rubrics.checklist)).map((item) => item.id));
  const marks = marksReply.ok ? verifyMarks(`${text}\n\n${CANARY}`, marksReply.output.marks, known) : null;
  const terms = termsReply.ok ? verifyTerms(text, termsReply.output.terms) : null;
  const canaryMarks = marks?.kept.filter((mark) => mark.start >= text.length).length ?? 0;
  const failures = [marksReply, termsReply].flatMap((reply) => (reply.ok ? [] : [reply.reason]));
  const trusted = failures.length === 0 && canaryMarks > 0;
  const scriptMarks = trusted && marks ? marks.kept.filter((mark) => mark.start < text.length) : null;
  const measured: Measured = { words: spokenText([text]).words.length, marks: scriptMarks, terms: trusted && terms ? terms.kept : null };
  const beatAt = (offset: number) => starts.findLast((start) => start.at <= offset)?.id ?? "";
  return {
    eval_version: writingJudgeVersion(rubrics, input.config),
    judge: judgeLabel(configs(input.config).judge),
    extractor: judgeLabel(configs(input.config).extractor),
    trusted, failures, canary_marks: canaryMarks,
    dropped: { marks: marks?.dropped ?? 0, terms: terms?.dropped ?? 0 },
    terms: terms?.kept.map((term) => term.term) ?? [],
    spend: spendOf([marksReply, termsReply]),
    rows: judgedRows(measured, input.policy ?? judgedPolicy(), beatAt),
  };
}
