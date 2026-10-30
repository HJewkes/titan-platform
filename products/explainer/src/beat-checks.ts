import type { BeatSpec } from "./beat-schema.js";
import { RECIPE_MAX_WORDS } from "./beat-schema.js";
import { isSlotRef, isTargetField } from "./beat-slots.js";
import type { DoctrineVocabulary } from "./doctrine-schema.js";

export const BEAT_ISSUE_CODES = ["unknown-vocabulary", "missing-beat-spec", "unknown-slots", "duration-order", "recipe-length", "emphasis-target"] as const;

export type BeatIssueCode = (typeof BEAT_ISSUE_CODES)[number];

export interface BeatIssue {
  code: BeatIssueCode;
  beat: string;
  message: string;
}

type BeatCheck = (spec: BeatSpec, vocabulary: DoctrineVocabulary) => BeatIssue[];

const issue = (code: BeatIssueCode, beat: string, message: string): BeatIssue => ({ code, beat, message });

const named: BeatCheck = ({ type }, vocabulary) => (vocabulary.beats.includes(type) ? [] : [issue("unknown-vocabulary", type, `beat ${type} is not in vocabulary.yaml`)]);

const slots: BeatCheck = ({ type, slots: ref }) => (isSlotRef(ref) ? [] : [issue("unknown-slots", type, `slots ${ref} is not a schema in BEAT_SLOTS`)]);

function duration({ type, durationS: [min, def, max] }: BeatSpec): BeatIssue[] {
  return min <= def && def <= max ? [] : [issue("duration-order", type, "durationS needs min <= default <= max")];
}

function recipe({ type, recipe: text }: BeatSpec): BeatIssue[] {
  const words = text.split(/\s+/).filter(Boolean).length;
  return words <= RECIPE_MAX_WORDS ? [] : [issue("recipe-length", type, `the recipe runs ${words} words; the packet allows ${RECIPE_MAX_WORDS}`)];
}

/** Each emphasis target is a slot list of elements with ids, so every cue resolves to one element. */
function emphasis({ type, slots: ref, emphasis: contract }: BeatSpec): BeatIssue[] {
  if (!contract || !isSlotRef(ref)) return [];
  return contract.targets
    .filter((field) => !isTargetField(ref, field))
    .map((field) => issue("emphasis-target", type, `emphasis target ${field} is not a list of elements with ids, or one line of text, in slots ${ref}`));
}

const BEAT_CHECKS: BeatCheck[] = [named, slots, duration, recipe, emphasis];

/**
 * Every refinement over the loaded beat specs against the vocabulary: each spec is named there,
 * each vocabulary beat has a spec, and each spec's slot ref and emphasis targets resolve.
 */
export function checkBeatSpecs(specs: ReadonlyMap<string, BeatSpec>, vocabulary: DoctrineVocabulary): BeatIssue[] {
  const missing = vocabulary.beats.filter((beat) => !specs.has(beat)).map((beat) => issue("missing-beat-spec", beat, `vocabulary.yaml names ${beat}, which has no beats/${beat}.yaml`));
  return [...missing, ...[...specs.values()].flatMap((spec) => BEAT_CHECKS.flatMap((check) => check(spec, vocabulary)))];
}
