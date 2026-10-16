import { contentTerms } from "@titan-design/speech-vet";
import type { L0Result } from "./eval-l0.js";
import type { MapLayout } from "./map-state.js";
import type { ScriptBeat, ScriptV1 } from "./script-schema.js";

export const sentencesOf = (text: string): string[] =>
  text
    .split(/(?<=[.?!])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

export const wordsOf = (text: string): string[] => text.split(/\s+/).filter((w) => /\w/.test(w));

export { contentTerms };

export const sharesTerm = (a: string, b: string): boolean => {
  const left = contentTerms(a);
  return [...contentTerms(b)].some((term) => left.has(term));
};

/** A beat that only opens its chapter: the first beat, asked as a learner question. */
export function isChapterOpen(beat: ScriptBeat, index: number, beats: readonly ScriptBeat[]): boolean {
  return beat.function === "LEARNER_Q" && beats[index - 1]?.chapter !== beat.chapter;
}

/** Beats that carry the body of the video: no chapter opens and no close. */
export const bodyBeats = (beats: readonly ScriptBeat[]): ScriptBeat[] =>
  beats.filter((beat, i) => !isChapterOpen(beat, i, beats) && beat.function !== "CLOSE");

/** Start of each beat as a share of the planned runtime. */
export function startShares(beats: readonly ScriptBeat[]): Map<string, number> {
  const total = beats.reduce((sum, b) => sum + b.plannedS, 0);
  let elapsed = 0;
  return new Map(
    beats.map((b) => {
      const share = elapsed / total;
      elapsed += b.plannedS;
      return [b.id, share];
    }),
  );
}

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function entityForms(name: string): string[] {
  const lower = name.toLowerCase().trim();
  return [lower, lower.replace(/[/]/g, " slash "), lower.replace(/[_-]/g, " ")].filter((form) => form.length > 2);
}

/**
 * Repo entities named by the script itself: glossary, new terms, on-screen labels and map node ids.
 * A caller with a fuller list (a review's repo names) passes it as `extra`.
 */
export function repoEntities(script: ScriptV1, layout?: MapLayout, extra: readonly string[] = []): string[] {
  const named = [
    ...script.video.glossary.map((g) => g.name),
    ...script.beats.flatMap((b) => [...b.new_terms, ...b.visual.labels]),
    ...(layout?.nodes ?? []).map((n) => n.id),
    ...extra,
  ];
  return [...new Set(named.flatMap(entityForms))].sort((a, b) => b.length - a.length);
}

/** Blanks every repo entity, so a process word inside a name ("the review server") never matches. */
export function maskEntities(text: string, entities: readonly string[]): string {
  return entities.reduce(
    (masked, entity) => masked.replace(new RegExp(`\\b${escape(entity)}\\b`, "gi"), "ENTITY"),
    text,
  );
}

export interface RowInput {
  value: number;
  threshold: number;
  pass: boolean;
  beats?: Iterable<string>;
  mode?: L0Result["mode"];
  severity?: L0Result["severity"];
}

export const ruleRow = (check_id: string, input: RowInput): L0Result => ({
  check_id,
  mode: input.mode ?? "heuristic",
  severity: input.severity ?? "error",
  value: Number.isInteger(input.value) ? input.value : Math.round(input.value * 1000) / 1000,
  threshold: input.threshold,
  pass: input.pass,
  detail_beats: [...new Set(input.beats ?? [])],
});

/** A count rule: every beat that matched is a defect, and the bar is zero. */
export const countRow = (check_id: string, beats: readonly string[], mode?: L0Result["mode"]): L0Result =>
  ruleRow(check_id, { value: beats.length, threshold: 0, pass: beats.length === 0, beats, ...(mode ? { mode } : {}) });
