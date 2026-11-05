import { listedLabels, spokenTerms } from "./eval-cold-terms.js";
import type { PaceBeat } from "./pace-items.js";

/** A list this long is where a different kind of thing can hide among its neighbours. */
export const ODD_ONE_OUT_MIN_ITEMS = 3;

export type ScoredKind = "what-why" | "invariant" | "spoken-term" | "viewer-term" | "assertion";
export const isTerm = (q: { kind: string }): boolean => q.kind === "spoken-term" || q.kind === "viewer-term";

export type ColdQuestion =
  | { kind: ScoredKind; beat: string; item: string; text: string }
  | { kind: "odd-one-out"; beat: string; items: string[]; text: string };

export const whatWhyText = (item: string): string => `What is "${item}", and why is it there?`;
// A spoken term is asked what it means, under its own rubric, held to the readers' bar: a sentence that only uses it
// leaves it undefined. Item labels keep the looser bar; asked beside the stricter one, v4's ch9 went from 0 to 22 a minute.
export const termText = (term: string): string => `What does "${term}" mean here, and why is it there?`;
export const invariantText = (item: string): string => `"${item}" must always hold. What keeps it, or how does it break today?`;
// The screen's claim is quoted so the viewer can look for it in the words; it still scores only on spoken quotes, so an
// assertion only the screen makes is not stated (XT-36: an audio-only listener gets every beat's claim).
export const assertionText = (assertion: string): string => `The screen says "${assertion}". Which spoken words tell a listener this, and why does it matter?`;
/** What the viewer was asked for each scored kind; an inv item is asked both what-why and invariant. */
export const COLD_QUESTION_TEXT: Readonly<Record<ScoredKind, (item: string) => string>> = {
  "what-why": whatWhyText,
  invariant: invariantText,
  "spoken-term": termText,
  "viewer-term": termText,
  assertion: assertionText,
};
export const oddOneOutText = (items: readonly string[]): string =>
  `Of ${items.map((i) => `"${i}"`).join(", ")}: which item is a different kind of thing, if any?`;

/**
 * Every question comes from the item track, or from a term spoken before any label shows it (see `spokenTerms`), so a
 * script cannot pass on questions written to suit it. `glossary` is the script's own declared term list; `assertions`
 * is each beat's on-screen claim by beat id.
 */
export function coldQuestions(
  beats: readonly PaceBeat[],
  glossary: readonly string[] = [],
  viewerTerms: readonly string[] = [],
  assertions: Readonly<Record<string, string>> = {},
): ColdQuestion[] {
  const terms = spokenTerms(beats, glossary, viewerTerms);
  return beats.flatMap((beat): ColdQuestion[] => {
    const listed = listedLabels(beat);
    const heard = terms.filter((t) => t.beat === beat.id);
    return [
      ...beat.newItems.map((i) => ({ kind: "what-why" as const, beat: beat.id, item: i.label, text: whatWhyText(i.label) })),
      ...beat.newItems.filter((i) => i.kind === "inv").map((i) => ({ kind: "invariant" as const, beat: beat.id, item: i.label, text: invariantText(i.label) })),
      ...heard.map((t) => ({ kind: t.viewer ? ("viewer-term" as const) : ("spoken-term" as const), beat: beat.id, item: t.term, text: termText(t.term) })),
      ...(listed.length >= ODD_ONE_OUT_MIN_ITEMS ? [{ kind: "odd-one-out" as const, beat: beat.id, items: listed, text: oddOneOutText(listed) }] : []),
      ...assertionQuestion(beat.id, assertions[beat.id]),
    ];
  });
}

function assertionQuestion(beat: string, assertion: string | undefined): ColdQuestion[] {
  const claim = assertion?.trim();
  return claim ? [{ kind: "assertion", beat, item: claim, text: assertionText(claim) }] : [];
}
