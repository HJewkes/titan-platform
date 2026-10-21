import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { BeatDirective, RegisterEditPlan } from "./rewrite-plan.js";
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

function directiveLines(directive: BeatDirective, round: RegisterEditPlan["round"]): string[] {
  const { numbers, triads, shape } = directive;
  return [
    ...(shape ? [shapeLine(shape)] : []),
    ...(numbers
      ? [`- Numbers: this beat speaks ${quoted(numbers)}. Keep the one its claim turns on and return the others as on-screen labels.`]
      : []),
    ...(triads ? [`- Lists of three: ${quoted(triads)}. Name the one that matters, or say how many and let the screen list them.`] : []),
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
    ...directiveLines(directive, round),
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
