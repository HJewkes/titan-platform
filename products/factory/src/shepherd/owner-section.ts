/**
 * The owner PR section (TP-1687 plan 4.1) built from facts already read: the PR, the run's policy, the pending gate and
 * the reviewer's verdict with its owner brief. Pure: the `shepherd brief` command (TP-1696) reads the inputs. Pros and
 * cons come only from the reviewer that read the diff; a missing owner brief leaves them empty so lintPrSection refuses
 * the section before it reaches the owner.
 */
import type { ManifestInput } from "@titan-design/review-schema";
import type { OwnerBrief } from "@titan-design/review-panel";
import type { OwnerGateReason } from "./policy.js";
import { whyAsked, type GateRuleRef, type WhyAsked } from "./why-asked.js";

type QuestionInput = ManifestInput["questions"][number];
export type OwnerSectionInputSection = NonNullable<ManifestInput["sections"]>[number];
export type OwnerQuestion = Extract<QuestionInput, { kind: "pick-one" }>;

export interface OwnerSectionPr {
  repo: string;
  number: number;
  url: string;
  title: string;
  head: string;
  /** The Summary section of the PR body, the implementer's own description. */
  summary?: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  ci: "green" | "red" | "pending";
  openDays: number;
  /** The PR changes rendered UI, so it owes a before and after pair. */
  ui: boolean;
}

export interface VisualPair {
  story: string;
  width: string;
  before: string;
  after: string;
}

export interface OwnerSectionInput {
  pr: OwnerSectionPr;
  taskId?: string;
  ownerGateReason?: OwnerGateReason;
  gate: { rule: GateRuleRef; reason: string; head: string };
  verdict?: { verdict: "MERGE" | "FIX_FIRST"; head: string; reviewer: string; ownerBrief?: OwnerBrief | null };
  /** Paired images for a UI PR, or the stated reason there are none. */
  visuals?: { pairs: VisualPair[]; base: string } | { none: string };
}

export const OWNER_ANSWERS = ["Approve merge", "Changes needed", "Close", "Defer"] as const;
export type OwnerAnswer = (typeof OWNER_ANSWERS)[number];

export interface OwnerSection {
  markdown: string;
  section: OwnerSectionInputSection;
  question: OwnerQuestion;
}

interface Recommended {
  answer: OwnerAnswer;
  words: string;
  rationale: string;
  confidence: number;
}

const SHORT_SHA = 7;
const short = (sha: string): string => sha.slice(0, SHORT_SHA);
const DOOR_WORDS = { "one-way": "hard to undo once agents rely on it", "two-way": "a revert undoes it" } as const;

/** The head the reviewer read, when it is not the head the owner would merge. */
function staleReview(input: OwnerSectionInput): string | undefined {
  const reviewed = input.verdict?.head ?? input.gate.head;
  return reviewed === input.pr.head ? undefined : reviewed;
}

function recommend(input: OwnerSectionInput): Recommended {
  const stale = staleReview(input);
  const by = input.verdict?.reviewer;
  if (input.verdict?.verdict !== "MERGE") {
    return { answer: "Changes needed", words: "changes", rationale: `No MERGE verdict${by ? ` from ${by}` : ""} at ${short(input.pr.head)}.`, confidence: 0.7 };
  }
  if (stale !== undefined) {
    return { answer: "Defer", words: `re-review at ${short(input.pr.head)}, then merge`, rationale: `${by} gave MERGE at ${short(stale)}, not at the PR head ${short(input.pr.head)}.`, confidence: 0.8 };
  }
  if (input.pr.ci !== "green") return { answer: "Defer", words: "defer", rationale: `CI is ${input.pr.ci} at ${short(input.pr.head)}.`, confidence: 0.6 };
  return { answer: "Approve merge", words: "merge", rationale: `${by} gave MERGE at ${short(input.pr.head)} and CI is green.`, confidence: 0.8 };
}

function headerLines(input: OwnerSectionInput, recommended: Recommended): string[] {
  const { pr } = input;
  const stale = staleReview(input);
  const reviewed = stale === undefined ? "" : ` (reviewed at ${short(stale)})`;
  const door = input.verdict?.ownerBrief?.doorType;
  const doorLine = door === undefined ? "Door type: not stated (the reviewer gave no owner brief)." : `Door type: ${door} (${DOOR_WORDS[door]}).`;
  return [
    `### ${pr.repo.split("/").at(-1)}#${pr.number}${input.taskId ? ` ${input.taskId}` : ""}: ${pr.title}`,
    "",
    `${pr.url} · head ${short(pr.head)}${reviewed} · +${pr.additions}/-${pr.deletions} in ${pr.changedFiles} files · CI ${pr.ci} at head · open ${pr.openDays} d`,
    "",
    `**Recommendation: ${recommended.words}.** ${doorLine}`,
  ];
}

function whatItDoes(input: OwnerSectionInput): string {
  const parts = [input.verdict?.ownerBrief?.what, input.pr.summary?.trim()].filter((part): part is string => !!part);
  return parts.length > 0 ? parts.join("\n\n") : `Neither the PR body nor a reviewer owner brief describes it at ${short(input.pr.head)}.`;
}

function whyItReaches(input: OwnerSectionInput, why: WhyAsked): string {
  const stale = staleReview(input);
  const staleNote = stale === undefined ? "" : ` The gate is at ${short(stale)}, but the PR head is ${short(input.pr.head)}; Shepherd has not reviewed the commits between them.`;
  const reviewerWhy = input.verdict?.ownerBrief?.why ? ` The reviewer adds: ${input.verdict.ownerBrief.why}` : "";
  return `${why.sentence} Rule \`${why.ruleId}\`.${staleNote}${reviewerWhy}`;
}

function consOf(input: OwnerSectionInput): string[] {
  const stale = staleReview(input);
  const cons = [...(input.verdict?.ownerBrief?.cons ?? [])];
  if (stale !== undefined) cons.unshift(`The commits after ${short(stale)} have had no Shepherd review; approving the gate as it stands would approve unreviewed code.`);
  return cons;
}

function visualsBlock(input: OwnerSectionInput): string {
  const { visuals, pr } = input;
  if (!pr.ui) return "No rendered change.";
  if (visuals === undefined) return `No visuals: no before and after capture was found for ${short(pr.head)}.`;
  if ("none" in visuals) return visuals.none;
  const rows = visuals.pairs.map((p) => `| ${p.story} / ${p.width} | ![](${p.before}) | ![](${p.after}) |`);
  return [`| Story / width | Before (base ${short(visuals.base)}) | After (head ${short(pr.head)}) |`, "|---|---|---|", ...rows].join("\n");
}

function nextSteps(input: OwnerSectionInput): string {
  const stale = staleReview(input);
  const yes = stale === undefined
    ? `Yes: Shepherd merges at ${short(input.pr.head)} once CI is green.`
    : `Yes: Shepherd supersedes the stale gate, the reviewer reviews ${short(input.pr.head)}, and if MERGE holds it merges without asking you again.`;
  return `${yes} No: the seat closes the PR${input.taskId ? ` and ${input.taskId} returns to the queue` : ""} with your note.`;
}

const bullets = (items: readonly string[]): string => items.map((item) => `- ${item}`).join("\n");

function renderMarkdown(input: OwnerSectionInput, why: WhyAsked, recommended: Recommended): string {
  return [
    ...headerLines(input, recommended),
    "",
    "#### What it does",
    whatItDoes(input),
    "",
    "#### Why it reaches you",
    whyItReaches(input, why),
    "",
    "#### Pros",
    bullets(input.verdict?.ownerBrief?.pros ?? []),
    "",
    "#### Cons",
    bullets(consOf(input)),
    "",
    "#### Before and after",
    visualsBlock(input),
    "",
    "#### If you say yes / If you say no",
    nextSteps(input),
    "",
  ].join("\n");
}

function harnessParts(input: OwnerSectionInput, markdown: string, recommended: Recommended): Omit<OwnerSection, "markdown"> {
  const { pr } = input;
  const questionId = `pr-${pr.number}`;
  const prompt = `Merge ${pr.repo}#${pr.number} at head ${short(pr.head)}?`;
  const variantKeys = input.visuals && "pairs" in input.visuals ? input.visuals.pairs.flatMap((p) => [p.before, p.after]) : [];
  const section: OwnerSectionInputSection = { id: `s-${questionId}`, title: `${pr.repo}#${pr.number}: ${pr.title}`, deciding: prompt, context: markdown, questionIds: [questionId], variantKeys, seeAlso: [] };
  const by = input.verdict?.reviewer ?? "shepherd";
  const question: OwnerQuestion = {
    id: questionId,
    kind: "pick-one",
    prompt,
    options: [...OWNER_ANSWERS],
    recommendation: { answer: recommended.answer, rationale: recommended.rationale, confidence: recommended.confidence, by },
  };
  return { section, question };
}

export function buildOwnerSection(input: OwnerSectionInput): OwnerSection {
  const why = whyAsked(input.gate.rule, input.gate.reason, input.ownerGateReason);
  const recommended = recommend(input);
  const markdown = renderMarkdown(input, why, recommended);
  return { markdown, ...harnessParts(input, markdown, recommended) };
}
