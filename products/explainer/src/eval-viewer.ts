import { z } from "zod";
import { canonicalSha } from "./eval-store.js";
import { EvidenceSchema, beatTexts, evalVersion, renderBeat, voidReason, type Track } from "./eval-evidence.js";
import { judgeLabel, type JudgeConfig, type JudgeHarness, type JudgeReply } from "./eval-harness.js";
import { sumSpend, type CanaryResult } from "./eval-judge.js";
import type { EvalBeat } from "./eval-view.js";

export const L2_EVAL_ID = "L2-viewer";
export const TRACKS: readonly Track[] = ["S", "SV", "V"];

/** The owner's five questions, three why-questions and the process-leak probe P. */
export const VIEWER_QUESTIONS = [
  { qid: "Q1", text: "What is the project for, and for whom?" },
  { qid: "Q2", text: "Draw the project's layout as lines of the form `A -> B : protocol`, one connection per line." },
  { qid: "Q3", text: "Where does a run of the project start?" },
  { qid: "Q4", text: "Name one key feature, and the package or file where it lives." },
  { qid: "Q5", text: "What should another team adopt from this project? Name up to three things." },
  { qid: "W1", text: "What goes wrong for a developer without this project?" },
  { qid: "W2", text: "Why does the key feature matter to the person using it?" },
  { qid: "W3", text: "Why is the entry point shaped the way it is?" },
  { qid: "P", text: "Summarise the video in three sentences." },
] as const;

/** A question about a component that cannot exist; the viewer must say the text does not answer it. */
export const CANARY_QID = "canary";
const canaryQuestion = (nonce: string): string => `What does the component named ${nonce} do?`;

const AnswersSchema = z.strictObject({
  answers: z.array(z.strictObject({ qid: z.string(), citations: z.array(EvidenceSchema), not_stated: z.boolean(), answer: z.string() })),
});
type Answer = z.infer<typeof AnswersSchema>["answers"][number];

/** `required_terms` grade an answer deterministically; Q5 counts them, every other question needs all. */
export interface AnswerKeyRow {
  qid: string;
  required_terms: string[];
}

export interface ReferenceEdge {
  from: string;
  to: string;
}

export interface L2Input {
  scriptSha: string;
  beats: readonly EvalBeat[];
  rubric: string;
  judge: JudgeConfig;
  harness: JudgeHarness;
  run: number;
  answerKey?: readonly AnswerKeyRow[];
  referenceGraph?: readonly ReferenceEdge[];
}

export interface Grade {
  grade: number | null;
  edge_f1: number | null;
  void_reason: string | null;
}

export interface ViewerAnswer extends Grade {
  track: Track;
  qid: string;
  answer: string;
  cited_beats: string[];
}

export interface L2Result {
  eval_version: string;
  judge: string;
  answers: ViewerAnswer[];
  canaries: CanaryResult[];
  failures: string[];
  trusted: boolean;
  spend: { usd: number; tokensIn: number; tokensOut: number };
}

export const l2EvalVersion = (input: Pick<L2Input, "rubric" | "judge" | "answerKey" | "referenceGraph">): string =>
  evalVersion(L2_EVAL_ID, input.rubric, input.judge, {
    questions: VIEWER_QUESTIONS,
    canary: canaryQuestion("<nonce>"),
    answer_key: input.answerKey ?? null,
    reference_graph: input.referenceGraph ?? null,
  });

const node = (name: string): string => name.trim().toLowerCase();

export function parseEdges(answer: string): ReferenceEdge[] {
  return answer.split("\n").flatMap((line) => {
    const match = /^\s*[-*]?\s*(.+?)\s*->\s*(.+?)\s*(?::.*)?$/.exec(line);
    return match ? [{ from: node(match[1]!), to: node(match[2]!) }] : [];
  });
}

/** Node recall and edge F1 of a drawn layout against the reference graph, by name, case-blind. */
export function layoutScores(answer: string, reference: readonly ReferenceEdge[]): { recall: number; f1: number } {
  const key = (e: ReferenceEdge) => `${node(e.from)}->${node(e.to)}`;
  const drawn = new Set(parseEdges(answer).map(key));
  const truth = new Set(reference.map(key));
  const hits = [...drawn].filter((e) => truth.has(e)).length;
  const f1 = drawn.size + truth.size === 0 ? 0 : (2 * hits) / (drawn.size + truth.size);
  const nodes = new Set(reference.flatMap((e) => [node(e.from), node(e.to)]));
  const named = new Set(parseEdges(answer).flatMap((e) => [e.from, e.to]));
  return { recall: nodes.size === 0 ? 0 : [...nodes].filter((n) => named.has(n)).length / nodes.size, f1 };
}

function termGrade(qid: string, answer: string, key: readonly AnswerKeyRow[] | undefined): number | null {
  const terms = key?.find((row) => row.qid === qid)?.required_terms;
  if (!terms) return null;
  const found = terms.filter((term) => answer.toLowerCase().includes(term.toLowerCase())).length;
  return qid === "Q5" ? found : Number(found === terms.length);
}

/** An uncited or unverifiable answer scores 0, which stops the viewer answering from prior knowledge. */
export function gradeAnswer(answer: Answer, texts: ReadonlyMap<string, string>, input: Pick<L2Input, "answerKey" | "referenceGraph">): Grade {
  if (answer.qid === "P") return { grade: null, edge_f1: null, void_reason: null };
  const reason = answer.not_stated ? "not stated" : voidReason(answer.citations, texts);
  if (reason) return { grade: 0, edge_f1: answer.qid === "Q2" ? 0 : null, void_reason: reason };
  if (answer.qid !== "Q2" || !input.referenceGraph) return { grade: termGrade(answer.qid, answer.answer, input.answerKey), edge_f1: null, void_reason: null };
  const { recall, f1 } = layoutScores(answer.answer, input.referenceGraph);
  return { grade: recall, edge_f1: f1, void_reason: null };
}

function viewerPrompt(rubric: string, beats: readonly EvalBeat[], track: Track, canary: string): string {
  const questions = [...VIEWER_QUESTIONS, { qid: CANARY_QID, text: canary }].map((q) => `- ${q.qid}: ${q.text}`).join("\n");
  return `${rubric}\n\n## The video (track ${track})\n\n${beats.map((b) => renderBeat(b, track)).join("\n\n")}\n\n## Questions\n\n${questions}\n`;
}

type ViewerReply = JudgeReply<z.infer<typeof AnswersSchema>>;

function trackAnswers(track: Track, reply: ViewerReply, texts: ReadonlyMap<string, string>, input: L2Input): ViewerAnswer[] {
  return VIEWER_QUESTIONS.map(({ qid }) => {
    const found = reply.ok ? reply.output.answers.find((a) => a.qid === qid) : undefined;
    if (!found) return { track, qid, answer: "", cited_beats: [], grade: null, edge_f1: null, void_reason: reply.ok ? "not answered" : `call failed: ${reply.reason}` };
    const cited = [...new Set(found.citations.map((c) => c.beat))];
    return { track, qid, answer: found.answer, cited_beats: cited, ...gradeAnswer(found, texts, input) };
  });
}

function canaryResult(track: Track, reply: ViewerReply): CanaryResult {
  const found = reply.ok ? reply.output.answers.find((a) => a.qid === CANARY_QID) : undefined;
  const got = found ? (found.not_stated ? "not_stated" : "answered") : "missing";
  return { canary: `unanswerable-${track}`, dim: CANARY_QID, got, pass: got === "not_stated" };
}

/** One L2 run: a fresh call per track, each with the unanswerable canary question. */
export async function runL2(input: L2Input): Promise<L2Result> {
  const answers: ViewerAnswer[] = [];
  const canaries: CanaryResult[] = [];
  const replies: ViewerReply[] = [];
  for (const track of TRACKS) {
    const canary = canaryQuestion(`relay-${canonicalSha({ scriptSha: input.scriptSha, run: input.run, track }).slice(0, 6)}`);
    const reply = await input.harness({ prompt: viewerPrompt(input.rubric, input.beats, track, canary), schema: AnswersSchema });
    replies.push(reply);
    answers.push(...trackAnswers(track, reply, beatTexts(input.beats, track), input));
    canaries.push(canaryResult(track, reply));
  }
  const failures = replies.flatMap((r) => (r.ok ? [] : [r.reason]));
  return {
    eval_version: l2EvalVersion(input),
    judge: judgeLabel(input.judge),
    answers,
    canaries,
    failures,
    trusted: failures.length === 0 && canaries.every((c) => c.pass),
    spend: sumSpend(replies),
  };
}
