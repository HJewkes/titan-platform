import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { AuditionEntrySchema } from "./calibration-auditions.js";
import type { CaseRef, JudgedOutput } from "./calibration-queue.js";
import { codeDecidedZero, COLD_QUESTION_TEXT } from "./eval-cold.js";
import { paceInput } from "./eval-pace-cli.js";
import { readTsv, scriptSha } from "./eval-store.js";
import type { PaceBeat } from "./pace-items.js";

/** Kept outside the repo: it names the private scripts and benches the queue is built from. */
export const ManifestSchema = z.object({
  schema: z.literal("calibration-manifest/v1"),
  cases: z.array(z.object({
    case: z.string().min(1),
    title: z.string().min(1),
    video_type: z.string().min(1),
    split: z.string().min(1),
    owner_named: z.boolean(),
    script: z.string().min(1),
    bench: z.string().min(1),
    /** The reader the judges ran with: a spike-era script fails strict script/v1. */
    format: z.enum(["spike", "v1"]).default("v1"),
  }).strict()).min(1),
  /** Audition records whose pick and runner-up the owner compares as a pair. */
  auditions: z.array(AuditionEntrySchema).default([]),
}).strict();
type Manifest = z.infer<typeof ManifestSchema>;
type ManifestCase = Manifest["cases"][number];

const BEAT_QUESTIONS: Record<string, string> = {
  B1: "Does this beat make one assertion about the project (not filler, a topic label or a list of topics)?",
  B2: "Is this beat's stake stated or inherited: why it matters to the viewer or a user?",
  B3: "Does this beat follow from the previous one as a consequence, contrast, answer or zoom?",
  B4: "Would the screen still teach this beat with the narration muted?",
  B5: "Does this beat talk about the project, not about how the video's authors reviewed or traced it?",
  B6: "Is the on-screen headline a specific assertion that does not repeat the narration?",
};

const RUBRIC_QUESTIONS: Record<string, string> = {
  J8: "Motivation: within the first 30 s or soon after, does a reason to care arrive, even if vague?",
  J9: "Clarity: could a newcomer follow it, even with some leaps they would trip on?",
  J10: "Novelty: does it give a fresh angle in places that a search or the project's README would not?",
  J11: "Memorability: would at least one image or fact stick a month from now?",
  J12: "Visual consistency: is there one look, even with stretches of plain cards?",
};

const coldText = (kind: string | undefined) => Object.entries(COLD_QUESTION_TEXT).find(([k]) => k === kind)?.[1];

const spokenOf = (beats: readonly PaceBeat[]): string => beats.map((b) => b.spoken).join(" ");
const screenOf = (beat: PaceBeat): string => (beat.items.length === 0 ? "" : `\nOn screen: ${beat.items.map((i) => i.label).join(", ")}`);

/** The whole script as heard, one paragraph a chapter, for the section the owner reads first. */
function scriptText(beats: readonly PaceBeat[]): string {
  const chapters = [...new Set(beats.map((b) => b.chapter))];
  return chapters.map((c) => `[${c}] ${spokenOf(beats.filter((b) => b.chapter === c))}`).join("\n\n");
}

interface Source {
  ref: CaseRef;
  sha: string;
  beats: PaceBeat[];
  evals: string;
}

/** The script's own verdicts that the judge gave: an empty score is voided, and a code-decided zero is not the judge's. */
const rows = (source: Source, file: string): Record<string, string>[] => {
  const path = join(source.evals, file);
  const judged = (r: Record<string, string>) => r.script_sha === source.sha && r.score !== "" && !codeDecidedZero(r.void_reason ?? "");
  return existsSync(path) ? readTsv(path).filter(judged) : [];
};

const origin = (r: Record<string, string>) => ({ configId: r.config_id ?? "", run: r.run ?? "" });

/**
 * A bench appends a row per run and per invocation, so one question can carry several verdicts. The owner labels
 * each question once, against the last verdict written: the latest config's last run. A target names everything
 * that identifies the question the judge was asked, so two questions never share one.
 */
function latestPerTarget(outputs: readonly JudgedOutput[]): JudgedOutput[] {
  return [...new Map(outputs.map((o) => [`${o.judge}\0${o.target}`, o])).values()];
}

function coldOutputs(source: Source): JudgedOutput[] {
  return rows(source, "cold-scores.tsv").flatMap((r) => {
    const text = coldText(r.kind);
    if (!text) return [];
    return [{
      ...source.ref,
      judge: "cold" as const,
      kind: "verdict" as const,
      target: `${r.beat} · ${r.kind} · ${r.item}`,
      question: `A first-time viewer hears only this chapter, then is asked: ${text(r.item!)} Does the chapter answer it?`,
      excerpt: `[${r.chapter}] ${spokenOf(source.beats.filter((b) => b.chapter === r.chapter))}`,
      pass: Number(r.score) > 0,
      ...origin(r),
    }];
  });
}

function rubricOutputs(source: Source): JudgedOutput[] {
  return rows(source, "cold-rubric-scores.tsv").filter((r) => RUBRIC_QUESTIONS[r.dim!]).map((r) => ({
    ...source.ref,
    judge: "cold-rubric",
    kind: "verdict",
    target: `script · ${r.dim}`,
    question: `Whole video. ${RUBRIC_QUESTIONS[r.dim!]}`,
    excerpt: "(judge the whole script shown at the top of this section)",
    pass: Number(r.score) >= 3,
    ...origin(r),
  }));
}

function beatOutputs(source: Source): JudgedOutput[] {
  const index = new Map(source.beats.map((b, i) => [b.id, i]));
  return rows(source, "beat-scores.tsv").filter((r) => BEAT_QUESTIONS[r.dim!] && index.has(r.beat!)).map((r) => {
    const at = index.get(r.beat!)!;
    const beat = source.beats[at]!;
    const previous = r.dim === "B3" && at > 0 ? `Previous beat: ${source.beats[at - 1]!.spoken}\n\n` : "";
    const excerpt = `${previous}This beat: ${beat.spoken}${screenOf(beat)}`;
    return { ...source.ref, judge: "l1", kind: "verdict", target: `${r.beat} · ${r.dim}`, question: BEAT_QUESTIONS[r.dim!]!, excerpt, pass: r.score === "1", ...origin(r) };
  });
}

/** A cold zero the judge gave ("not stated", or a quote not in the chapter) carries a void_reason too, and is kept. */
export function judgedOutputs(entry: ManifestCase): { outputs: JudgedOutput[]; script: string } {
  const raw: unknown = JSON.parse(readFileSync(entry.script, "utf8"));
  const beats = paceInput(raw, entry.format, undefined).beats;
  const ref = { case: entry.case, videoType: entry.video_type, split: entry.split, ownerNamed: entry.owner_named };
  const source = { ref, sha: scriptSha(raw), beats, evals: join(entry.bench, "evals") };
  return { outputs: latestPerTarget([...coldOutputs(source), ...rubricOutputs(source), ...beatOutputs(source)]), script: scriptText(beats) };
}
