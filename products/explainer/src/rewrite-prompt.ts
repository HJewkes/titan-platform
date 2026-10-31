import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { BeatDirective, RefusalRule, RegisterEditPlan } from "./rewrite-plan.js";
import { cuedWordsIn } from "./rewrite-spans.js";
import { beatCues, spokenWordIndex, type ScriptBeat, type ScriptChapter } from "./script-schema.js";

export interface RewritePromptDeps {
  /** Overrides the shipped `doctrine/guides` directory. */
  guidesDir?: string;
}

type PromptBeat = Pick<ScriptBeat, "id" | "spoken" | "new_terms" | "visual">;

const DEFAULT_GUIDES_DIR = fileURLToPath(new URL("../doctrine/guides/", import.meta.url));

const readGuide = (dir: string, name: string): string => readFileSync(`${dir}/${name}`, "utf8").trimEnd();

const quoted = (spans: readonly string[]): string => spans.map((span) => `"${span}"`).join(", ");

const countWords = (lengths: readonly number[]): string =>
  lengths.length === 1 ? `${lengths[0]}` : `${lengths.slice(0, -1).join(", ")} and ${lengths.at(-1)}`;

function shapeLine(lengths: readonly number[]): string {
  if (lengths.length === 1) return `- Shape: one sentence of about ${lengths[0]} words.`;
  return `- Shape: ${lengths.length} sentences of about ${countWords(lengths)} words, in any order.`;
}

// Plain words only: a note names what went wrong in the beat, never a rule id, a threshold or a band (TP-3817 S20).
const REFUSAL_NOTES: ReadonlyMap<string, string> = new Map(
  Object.entries({
    empty: "the line came back empty; say the beat in full",
    entity: "a name from the original went missing; keep every name and id in the line",
    markup: "a linked word was dropped or changed; keep each one exactly as written",
    terms: "too many of the original's own words went missing; keep its wording and change less",
    length: "the line grew or shrank too far; keep it close to the original's length",
    "number-lost": "a number the screen shows left the line; keep saying it, and put no number in a label",
    "number-invented": "a count appeared that the original never says; add no number of your own",
    "range-split": "a range lost one of its ends; keep both ends or cut the whole range",
    "number-vague":"a vague word stood in for a number; keep the number or cut the clause",
    "device-added": "it gained a colon, a semicolon, a tail or a \"let's\" the original did not have; say it as a plain sentence",
    "closer-added": "it ended on a new short summing-up line the original did not have; end where the point is made",
    "list-lost": "an item of the list left the line without a label of its own; label every item",
    "list-emptied": "keep one item of the list in the line",
    "cue-lost": "a cue word was no longer spoken; say every cue word",
    "cue-order": "the cue words came in a different order; keep the original order",
    "new-term": "a term this beat introduces was no longer spoken; keep saying it",
    "sentence-cap": "a sentence was too long to say in one breath; split it",
    missing: "the reply left this beat out; return an entry for it",
  } satisfies Record<RefusalRule, string>),
);
const FALLBACK_NOTE = "it changed what the beat says; stay closer to the original";

/** Why a refused rewrite was not used, in plain words; a rule with no note of its own gets a generic one. */
export const refusalNote = (rule: string): string => REFUSAL_NOTES.get(rule) ?? FALLBACK_NOTE;

const refusalLines = (refused: readonly string[]): string[] =>
  [...new Set(refused.map(refusalNote))].map((note) => `- Your last version was not used: ${note}.`);

/** A list the plan lets collapse holds at most one cue word; the line names it so the collapse keeps that item spoken. */
function cuedItemLines(triads: readonly string[], beat: PromptBeat): string[] {
  const cued = [...new Set(triads.flatMap((triad) => cuedWordsIn(triad, beat.visual)))];
  if (cued.length === 0) return [];
  return [`- The screen cues on ${quoted(cued)}: the list item that holds each one is the item you keep in the line.`];
}

function directiveLines(beat: PromptBeat, directive: BeatDirective, round: RegisterEditPlan["round"]): string[] {
  const { numbers, triads, phrases, shape, refused } = directive;
  return [
    ...refusalLines(refused ?? []),
    ...(shape ? [shapeLine(shape)] : []),
    ...(numbers
      ? [`- Numbers: this beat speaks ${quoted(numbers)}. Keep the one its claim turns on and cut the others with the clause they count; put none of them in labels_added.`]
      : []),
    ...(triads
      ? [
          `- Lists of three: ${quoted(triads)}. Put every item in labels_added, one each, and keep at most a single item in the line; you may say how many there are.`,
          ...cuedItemLines(triads, beat),
        ]
      : []),
    ...(phrases ? [`- Stock phrases: ${quoted(phrases)}. Say what each one means in plain words of your own.`] : []),
    ...(round > 1 ? ["- Change only what the lines above name; keep the rest of the beat as written."] : []),
  ];
}

/** The beat's cue words in spoken order, each once, without the `#n` occurrence suffix. */
function cueWords(beat: PromptBeat): string[] {
  const index = spokenWordIndex(beat);
  const ordered = [...new Set(beatCues(beat.visual))].sort((a, b) => index(a) - index(b));
  return [...new Set(ordered.map((cue) => cue.split("#")[0]!))];
}

function renderBeat(beat: PromptBeat, directive: BeatDirective, round: RegisterEditPlan["round"]): string {
  return [
    `## ${beat.id}`,
    `Original: ${beat.spoken}`,
    `Cue words, in order: ${cueWords(beat).join(", ") || "(none)"}`,
    `Terms to keep: ${beat.new_terms.join(", ") || "(none)"}`,
    "Directive:",
    ...directiveLines(beat, directive, round),
  ].join("\n");
}

/** One chapter's rewrite prompt: the guide, then each beat the plan directs, in script order. */
export function renderRewritePrompt(chapter: ScriptChapter, beats: readonly PromptBeat[], plan: RegisterEditPlan, deps: RewritePromptDeps = {}): string {
  const directives = new Map(plan.directives.map((directive) => [directive.beat, directive]));
  const sections = beats.flatMap((beat) => {
    const directive = directives.get(beat.id);
    return directive ? [renderBeat(beat, directive, plan.round)] : [];
  });
  const guide = readGuide(deps.guidesDir ?? DEFAULT_GUIDES_DIR, "rewrite-v0.md");
  return [guide, `# Chapter ${chapter.id}: ${chapter.question}`, ...sections].join("\n\n") + "\n";
}
