import type { ScriptBeat } from "../script-schema.js";
import { firstWord, itemReveals } from "./label-parse.js";
import type { BeatScope, Derivation, Derived } from "./types.js";

const ACTOR_MAX = 48;

const leadLine = (beat: ScriptBeat): string => beat.visual.labels[0] ?? beat.visual.assertion;
const items = (field: string, texts: readonly string[]) => texts.map((text, i) => ({ id: `${field}-${i + 1}`, text }));
const onFirstWord = (beat: ScriptBeat, target: string) => ({ target, atCue: firstWord(beat) });

/** The line is the first label (or the assertion); the other labels are cards, each on its cue. */
export function deriveHook(beat: ScriptBeat): Derivation {
  const cards = items("cards", beat.visual.labels.slice(1));
  return { slots: { line: leadLine(beat), cards }, reveals: [onFirstWord(beat, "line"), ...itemReveals(beat, "cards", cards.length)] };
}

export function deriveChapter(beat: ScriptBeat, scope: BeatScope): Derivation {
  const { n, label, question } = scope.chapter;
  return { slots: { n, title: beat.visual.labels[0] ?? label, question }, reveals: [onFirstWord(beat, "title")] };
}

export const deriveOutro = (beat: ScriptBeat): Derived => ({ slots: { line: leadLine(beat) }, reveals: [onFirstWord(beat, "line")] });

/** The line, then the action as the second label; with no action it draws as the outro card on the same component. */
export function deriveButton(beat: ScriptBeat): Derivation {
  const action = beat.visual.labels[1];
  if (action === undefined) return { reason: "button has no action label after its line", fallback: { spec: "outro", derived: deriveOutro(beat) } };
  return { slots: { line: leadLine(beat), action }, reveals: [onFirstWord(beat, "line")] };
}

export const deriveHeld = (beat: ScriptBeat): Derivation => ({ slots: { line: beat.visual.assertion }, reveals: [] });

/** The first chip with a fact id, as a slot source. */
export function factSource(beat: ScriptBeat): { label: string; ref: string } | undefined {
  const chip = beat.visual.chips.find((found) => found.fact_id !== undefined);
  return chip === undefined ? undefined : { label: chip.text, ref: chip.fact_id! };
}

export function deriveClaim(beat: ScriptBeat): Derivation {
  const source = factSource(beat);
  return { slots: { claim: leadLine(beat), ...(source === undefined ? {} : { source }) }, reveals: [onFirstWord(beat, "claim")] };
}

/** The chapters promised are the labels when there are two or more, else the script's chapter labels. */
export function derivePromise(beat: ScriptBeat, scope: BeatScope): Derivation {
  const named = beat.visual.labels.length >= 2 ? beat.visual.labels : scope.chapterLabels;
  if (named.length < 2) return { reason: "promise needs at least two chapters to name" };
  return { slots: { line: beat.visual.assertion, chapters: items("chapters", named) }, reveals: itemReveals(beat, "chapters", named.length) };
}

/** The audience persona follows the labels as steps. */
export function deriveUserFlow(beat: ScriptBeat, scope: BeatScope): Derivation {
  const { persona } = scope;
  if (persona === undefined || persona.length > ACTOR_MAX) return { reason: `user-flow needs an authored audience persona of at most ${ACTOR_MAX} characters as its actor` };
  if (beat.visual.labels.length < 2) return { reason: "user-flow needs at least two step labels" };
  return { slots: { actor: persona, steps: items("steps", beat.visual.labels) }, reveals: itemReveals(beat, "steps", beat.visual.labels.length) };
}

/** Resolve fills a companion card's link itself (resolver `slots`); the script adds nothing to it. */
export const deriveCompanionLink = (): Derivation => ({ slots: {}, reveals: [] });
