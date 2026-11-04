import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { JudgedOutput } from "./calibration-queue.js";

/** A manifest's audition entry: one audition/v1 record whose pick and runner-up become one pair item. */
export const AuditionEntrySchema = z.object({
  case: z.string().min(1),
  title: z.string().min(1),
  video_type: z.string().min(1),
  split: z.string().min(1),
  owner_named: z.boolean(),
  record: z.string().min(1),
}).strict();
export type AuditionEntry = z.infer<typeof AuditionEntrySchema>;

const RUBRIC_DIMS = ["J8", "J9", "J10", "J11"];

/** Only the audition/v1 fields a pair item reads; the record's own type is a TS interface with no schema. */
const CandidateSchema = z.looseObject({
  id: z.string().min(1),
  spine: z.looseObject({
    sentence: z.string(),
    hook: z.looseObject({ line: z.string() }),
    blocks: z.array(z.looseObject({ question: z.string(), seconds: z.number() })).min(1),
  }),
  rubric: z.looseObject({
    eval_version: z.string(),
    dims: z.array(z.looseObject({ dim: z.string(), verdict: z.looseObject({ score: z.number().nullable() }) })),
  }).nullable(),
});
type Candidate = z.infer<typeof CandidateSchema>;

const RecordSchema = z.looseObject({
  schema: z.literal("audition/v1"),
  profile: z.looseObject({ type: z.string(), version: z.string() }),
  rules: z.looseObject({ pick: z.string() }),
  candidates: z.array(CandidateSchema),
  pick: z.looseObject({ candidate: z.string() }),
  runnerUp: z.looseObject({ candidate: z.string() }),
});

const PAIR_QUESTION = "A first-time viewer gets one of these two storyboards for the same video. Which would you rather they watched?";

/** What the owner compares: the storyboard as told, never its structure, system, candidate id or scores. */
function storyboard(side: "A" | "B", candidate: Candidate): string {
  const blocks = candidate.spine.blocks.map((b, i) => `${i + 1}. ${b.question} (${b.seconds} s)`);
  return [`Storyboard ${side}`, `In one sentence: ${candidate.spine.sentence}`, `Opens on: ${candidate.spine.hook.line}`, ...blocks].join("\n");
}

/** Each scored row's sum over the rows both sides scored, so a row voided on one side never decides the pair. */
function rubricSums(a: Candidate, b: Candidate): [number, number] | null {
  if (!a.rubric || !b.rubric) return null;
  const scores = (c: Candidate) => new Map(c.rubric!.dims.filter((d) => RUBRIC_DIMS.includes(d.dim) && d.verdict.score !== null).map((d) => [d.dim, d.verdict.score!]));
  const [left, right] = [scores(a), scores(b)];
  const shared = [...left.keys()].filter((dim) => right.has(dim));
  if (shared.length === 0) return null;
  const sum = (m: Map<string, number>) => shared.reduce((total, dim) => total + m.get(dim)!, 0);
  return [sum(left), sum(right)];
}

function readRecord(path: string): z.infer<typeof RecordSchema> {
  const parsed = RecordSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success) throw new Error(`audition record ${path} is not a readable audition/v1: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  return parsed.data;
}

const candidateOf = (record: z.infer<typeof RecordSchema>, id: string, path: string): Candidate => {
  const found = record.candidates.find((c) => c.id === id);
  if (!found) throw new Error(`audition record ${path} names candidate ${id}, which it does not hold`);
  return found;
};

/**
 * The pick against its runner-up as one owner question with a key entry per picker: audition-code prefers the pick,
 * and audition-rubric the side with the higher J8 to J11 sum, giving no entry on a tie. The seed sets which side is A.
 * The code picker has no eval_version of its own, so the pick rule's text stands for it.
 */
export function auditionOutputs(entry: AuditionEntry, seed: string): JudgedOutput[] {
  const record = readRecord(entry.record);
  const pick = candidateOf(record, record.pick.candidate, entry.record);
  const runnerUp = candidateOf(record, record.runnerUp.candidate, entry.record);
  const sha = createHash("sha256").update(readFileSync(entry.record)).digest("hex").slice(0, 12);
  const pickIsA = Number.parseInt(createHash("sha256").update(`${seed}\0${sha}`).digest("hex").slice(0, 2), 16) % 2 === 0;
  const [a, b] = pickIsA ? [pick, runnerUp] : [runnerUp, pick];
  const target = `${sha} · ${pick.id} vs ${runnerUp.id}`;
  const shared = {
    case: entry.case, videoType: entry.video_type, split: entry.split, ownerNamed: entry.owner_named, kind: "pair" as const, group: target,
    target, question: PAIR_QUESTION, excerpt: `${storyboard("A", a)}\n\n${storyboard("B", b)}`, configId: `${record.profile.type}@${record.profile.version}`, run: sha,
  };
  const sums = rubricSums(a, b);
  const rubric = sums && sums[0] !== sums[1] ? [{ ...shared, judge: "audition-rubric" as const, pass: sums[0] > sums[1], evalVersion: a.rubric!.eval_version }] : [];
  const codeVersion = createHash("sha256").update(record.rules.pick).digest("hex").slice(0, 12);
  return [{ ...shared, judge: "audition-code", pass: pickIsA, evalVersion: codeVersion }, ...rubric];
}
