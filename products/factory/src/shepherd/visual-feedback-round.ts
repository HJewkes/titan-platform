// TP-5409 (gate model S6): one repo's merged visual PRs of a week as one round@2 of kind `feedback`. It shows what
// changed and asks one optional notes question per PR; nothing in it binds a merge, as every PR in it has merged already.
import { createHash } from "node:crypto";
import type { MergedVisual } from "./visual-feedback-merged.js";

const ROUND_SCHEMA = "titan-review/round@2";
/** round@2 requires a loopback Storybook URL even for a round with no frames; nothing here loads it. */
const NO_STORYBOOK = "http://127.0.0.1:6006";
const SHOWN_PATHS = 8;
const MAX_FILES = 200;

interface FeedbackSection {
  id: string;
  title: string;
  deciding: string;
  changed: string;
  context: string;
  questionIds: string[];
}

interface FeedbackQuestion {
  id: string;
  kind: "text";
  prompt: string;
}

interface FeedbackPrGroup {
  pr: string;
  headSha: string;
  sectionIds: string[];
  task?: { id: string };
  files: { path: string }[];
}

export interface FeedbackRound {
  schema: typeof ROUND_SCHEMA;
  kind: "feedback";
  unit: string;
  round: 1;
  storybookUrl: string;
  context: string;
  widths: number[];
  variants: [];
  recommendations: "after-answer";
  sections: FeedbackSection[];
  questions: FeedbackQuestion[];
  prGroups: FeedbackPrGroup[];
}

/** `vf-<name>-<hash>-<week>`: the repo name for the reader, a hash of the full repo key so two owners never share a unit, all within a round id's 64 characters. */
export function feedbackUnit(repo: string, week: string): string {
  const key = repo.toLowerCase();
  const name = (key.split("/")[1] ?? key).replace(/[^a-z0-9_-]/g, "-").slice(0, 30);
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 6);
  return `vf-${name}-${hash}-${week}`;
}

function changedLine(paths: readonly string[]): string {
  const shown = paths.slice(0, SHOWN_PATHS).join(", ");
  const more = paths.length > SHOWN_PATHS ? ` and ${paths.length - SHOWN_PATHS} more` : "";
  return `${paths.length} visual path(s) changed: ${shown}${more}.`;
}

function sectionOf(repo: string, merged: MergedVisual): FeedbackSection {
  const tier = merged.tier === undefined ? "" : ` Measured visual tier ${merged.tier}, a label only.`;
  const task = merged.task === undefined ? "" : ` Task ${merged.task}.`;
  return {
    id: `pr-${merged.pr}`,
    title: `${repo}#${merged.pr}`,
    deciding: "Nothing to decide: this already merged. Note anything to change in a later iteration; each note becomes a task.",
    changed: changedLine(merged.visualChanged),
    context: `Merged ${merged.mergedAt.slice(0, 10)} as ${merged.mergeSha.slice(0, 12)} from head ${merged.headSha.slice(0, 12)}.${tier}${task}`,
    questionIds: [`notes-pr-${merged.pr}`],
  };
}

const questionOf = (repo: string, { pr }: MergedVisual): FeedbackQuestion => ({ id: `notes-pr-${pr}`, kind: "text", prompt: `Notes or ideas for a later iteration of ${repo}#${pr} (optional)` });

function prGroupOf(repo: string, merged: MergedVisual): FeedbackPrGroup {
  const files = merged.visualChanged.slice(0, MAX_FILES).map((path) => ({ path }));
  return { pr: `${repo}#${merged.pr}`, headSha: merged.headSha, sectionIds: [`pr-${merged.pr}`], ...(merged.task !== undefined && { task: { id: merged.task } }), files };
}

/** The week's sheet, or undefined when nothing visual merged: an empty round is never filed. Same input, same bytes. */
export function feedbackRound(repo: string, week: string, merged: readonly MergedVisual[]): FeedbackRound | undefined {
  if (merged.length === 0) return undefined;
  return {
    schema: ROUND_SCHEMA,
    kind: "feedback",
    unit: feedbackUnit(repo, week),
    round: 1,
    storybookUrl: NO_STORYBOOK,
    context: `Visual feedback for ${repo}, ISO week ${week}: ${merged.length} merged PR(s) with visual changes. Nothing here blocks or undoes a merge.`,
    widths: [1280],
    variants: [],
    recommendations: "after-answer",
    sections: merged.map((entry) => sectionOf(repo, entry)),
    questions: merged.map((entry) => questionOf(repo, entry)),
    prGroups: merged.map((entry) => prGroupOf(repo, entry)),
  };
}
