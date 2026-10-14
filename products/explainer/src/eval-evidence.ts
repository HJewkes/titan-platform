import { readFileSync } from "node:fs";
import { z } from "zod";
import { canonicalSha } from "./eval-store.js";
import { judgeIdentity, type JudgeConfig } from "./eval-harness.js";
import type { EvalBeat } from "./eval-view.js";

/** The rubric prompts ship beside `src/` and `dist/`, so one relative URL serves both. */
const RUBRIC_DIR = new URL("../rubrics/", import.meta.url);

export const readRubric = (file: string): string => readFileSync(new URL(file, RUBRIC_DIR), "utf8");

/**
 * Names what an eval measured: the rubric bytes, the judge's identity and the fixed inputs
 * (canaries, questions, answer keys) it ran with. Any of them changing starts a new
 * eval_version, so old rows never mix in.
 */
export const evalVersion = (evalId: string, rubric: string, judge: JudgeConfig, fixtures: unknown): string =>
  canonicalSha({ eval_id: evalId, rubric_sha: canonicalSha(rubric), judge: judgeIdentity(judge), fixtures });

export const EvidenceSchema = z.strictObject({ beat: z.string(), quote: z.string() });
export type Evidence = z.infer<typeof EvidenceSchema>;

/** Shorter quotes match almost any beat, which would let a judge cite without reading. */
export const MIN_QUOTE_WORDS = 2;

const normalize = (text: string): string => text.replace(/\s+/g, " ").trim();

/** Why a cited verdict is void, or null when every quote appears verbatim in the beat it cites. */
export function voidReason(evidence: readonly Evidence[], beatTexts: ReadonlyMap<string, string>): string | null {
  if (evidence.length === 0) return "no evidence";
  for (const { beat, quote } of evidence) {
    const text = beatTexts.get(beat);
    if (text === undefined) return `cites unknown beat ${beat}`;
    const needle = normalize(quote);
    if (needle.split(" ").length < MIN_QUOTE_WORDS) return `quote shorter than ${MIN_QUOTE_WORDS} words in ${beat}`;
    if (!normalize(text).includes(needle)) return `quote not found in ${beat}`;
  }
  return null;
}

export const formatEvidence = (evidence: readonly Evidence[]): string => evidence.map((e) => `${e.beat}:${e.quote}`).join(" | ");

/** S is the narration alone, V the screen alone (the muted test), SV both. */
export type Track = "S" | "SV" | "V";

const list = (label: string, items: readonly string[]): string[] => (items.length > 0 ? [`${label}: ${items.join("; ")}`] : []);

function visualLines(beat: EvalBeat): string[] {
  const v = beat.visual;
  return [
    `headline: ${beat.assertion}`,
    ...list("labels", v.labels),
    ...list("chips", v.chips),
    ...list("map shows", v.nodes_shown),
    ...list("map edges", v.edges_shown),
    ...list("on screen", v.state_changes.map((c) => `${c.op} ${c.target}`)),
  ];
}

/** What a reader sees of one beat on a track; cited quotes are checked against exactly this text. */
const beatBody = (beat: EvalBeat, track: Track): string =>
  [...(track === "V" ? [] : [`spoken: ${beat.spoken}`]), ...(track === "S" ? [] : visualLines(beat))].join("\n");

/** The header is not quotable, so a judge cannot cite a beat's id or function as evidence. */
export function renderBeat(beat: EvalBeat, track: Track, withFunction = false): string {
  return `${withFunction ? `[${beat.id}] ${beat.function}` : `[${beat.id}]`}\n${beatBody(beat, track)}`;
}

export const beatTexts = (beats: readonly EvalBeat[], track: Track): Map<string, string> =>
  new Map(beats.map((beat) => [beat.id, beatBody(beat, track)]));
