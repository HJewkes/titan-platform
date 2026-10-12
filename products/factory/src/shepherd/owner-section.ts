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
type OwnerSectionInputSection = NonNullable<ManifestInput["sections"]>[number];
type OwnerQuestion = Extract<QuestionInput, { kind: "pick-one" }>;

interface OwnerSectionPr {
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

interface VisualPair {
  story: string;
  width: string;
  before: string;
  after: string;
}

export interface OwnerSectionInput {
  pr: OwnerSectionPr;
  taskId?: string;
  ownerGateReason?: OwnerGateReason;
  /** `mergeableState` is the state the merge evidence judged at the gate's head, when it recorded one. */
  gate: { rule: GateRuleRef; reason: string; head: string; mergeableState?: string };
  verdict?: { verdict: "MERGE" | "FIX_FIRST"; head: string; reviewer: string; ownerBrief?: OwnerBrief | null };
  /** Paired images for a UI PR, or the stated reason there are none. */
  visuals?: { pairs: VisualPair[]; base: string } | { none: string };
}

const OWNER_ANSWERS = ["Approve merge", "Changes needed", "Close", "Defer"] as const;
type OwnerAnswer = (typeof OWNER_ANSWERS)[number];

interface OwnerSection {
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

/** The gate and the review are read at their own heads; either may lag the PR head the owner would merge. */
interface Heads {
  pr: string;
  /** The gate's head, when it is not the PR head. */
  staleGate?: string;
  /** The verdict's head, when it is not the PR head; `reviewed` is false when no verdict exists at all. */
  staleReview?: string;
  reviewed: boolean;
}

function headsOf(input: OwnerSectionInput): Heads {
  const pr = input.pr.head;
  const verdictHead = input.verdict?.head;
  return {
    pr,
    reviewed: verdictHead !== undefined,
    ...(input.gate.head !== pr && { staleGate: input.gate.head }),
    ...(verdictHead !== undefined && verdictHead !== pr && { staleReview: verdictHead }),
  };
}

function recommend(input: OwnerSectionInput, heads: Heads): Recommended {
  const by = input.verdict?.reviewer;
  const head = short(heads.pr);
  if (input.verdict?.verdict !== "MERGE") {
    return { answer: "Changes needed", words: "changes", rationale: `No MERGE verdict${by ? ` from ${by}` : ""} at ${head}.`, confidence: 0.7 };
  }
  if (heads.staleReview !== undefined) {
    return { answer: "Defer", words: `re-review at ${head}, then merge`, rationale: `${by} gave MERGE at ${short(heads.staleReview)}, not at the PR head ${head}.`, confidence: 0.8 };
  }
  if (heads.staleGate !== undefined) {
    return { answer: "Defer", words: `let Shepherd re-decide at ${head}`, rationale: `The gate is at ${short(heads.staleGate)}; ${by} gave MERGE at the PR head ${head}, so Shepherd should decide that head afresh.`, confidence: 0.8 };
  }
  if (input.pr.ci !== "green") return { answer: "Defer", words: "defer", rationale: `CI is ${input.pr.ci} at ${head}.`, confidence: 0.6 };
  return { answer: "Approve merge", words: "merge", rationale: `${by} gave MERGE at ${head} and CI is green.`, confidence: 0.8 };
}

function reviewNote(heads: Heads): string {
  if (!heads.reviewed) return " (not reviewed)";
  return heads.staleReview === undefined ? "" : ` (reviewed at ${short(heads.staleReview)})`;
}

function headerLines(input: OwnerSectionInput, heads: Heads, recommended: Recommended): string[] {
  const { pr } = input;
  const door = input.verdict?.ownerBrief?.doorType;
  const doorLine = door === undefined ? "Door type: not stated (the reviewer gave no owner brief)." : `Door type: ${door} (${DOOR_WORDS[door]}).`;
  return [
    `### ${pr.repo.split("/").at(-1)}#${pr.number}${input.taskId ? ` ${input.taskId}` : ""}: ${pr.title}`,
    "",
    `${pr.url} · head ${short(pr.head)}${reviewNote(heads)} · +${pr.additions}/-${pr.deletions} in ${pr.changedFiles} files · CI ${pr.ci} at head · open ${pr.openDays} d`,
    "",
    `**Recommendation: ${recommended.words}.** ${doorLine}`,
  ];
}

function whatItDoes(input: OwnerSectionInput): string {
  const parts = [input.verdict?.ownerBrief?.what, input.pr.summary?.trim()].filter((part): part is string => !!part);
  return parts.length > 0 ? parts.join("\n\n") : `Neither the PR body nor a reviewer owner brief describes it at ${short(input.pr.head)}.`;
}

function headNotes(heads: Heads): string {
  const head = short(heads.pr);
  const gate = heads.staleGate === undefined ? "" : ` The gate is at ${short(heads.staleGate)}, but the PR head is ${head}.`;
  if (!heads.reviewed) return `${gate} No reviewer has given a verdict on this PR.`;
  const review = heads.staleReview === undefined ? "" : ` The last review is at ${short(heads.staleReview)}; no reviewer has read the commits after it.`;
  return `${gate}${review}`;
}

function whyItReaches(input: OwnerSectionInput, heads: Heads, why: WhyAsked): string {
  const reviewerWhy = input.verdict?.ownerBrief?.why ? ` The reviewer adds: ${input.verdict.ownerBrief.why}` : "";
  return `${why.sentence} Rule \`${why.ruleId}\`.${headNotes(heads)}${reviewerWhy}`;
}

function headCons(heads: Heads): string[] {
  if (!heads.reviewed) return [`No reviewer has read ${short(heads.pr)}; approving would approve unreviewed code.`];
  if (heads.staleReview !== undefined) return [`The commits after ${short(heads.staleReview)} have had no review; approving the gate as it stands would approve unreviewed code.`];
  if (heads.staleGate !== undefined) return [`The gate was opened at ${short(heads.staleGate)}, not at the PR head ${short(heads.pr)}; answering it decides a head that would not merge.`];
  return [];
}

function consOf(input: OwnerSectionInput, heads: Heads): string[] {
  return [...headCons(heads), ...(input.verdict?.ownerBrief?.cons ?? [])];
}

function visualsBlock(input: OwnerSectionInput): string {
  const { visuals, pr } = input;
  if (!pr.ui) return "No rendered change.";
  if (visuals === undefined) return `No visuals: no before and after capture was found for ${short(pr.head)}.`;
  if ("none" in visuals) return visuals.none;
  const rows = visuals.pairs.map((p) => `| ${p.story} / ${p.width} | ![](${p.before}) | ![](${p.after}) |`);
  return [`| Story / width | Before (base ${short(visuals.base)}) | After (head ${short(pr.head)}) |`, "|---|---|---|", ...rows].join("\n");
}

function yesStep(heads: Heads): string {
  const head = short(heads.pr);
  if (!heads.reviewed || heads.staleReview !== undefined) return `Yes: Shepherd supersedes the gate, a reviewer reviews ${head}, and if MERGE holds it merges without asking you again.`;
  if (heads.staleGate !== undefined) return `Yes: Shepherd supersedes the gate at ${short(heads.staleGate)} and decides ${head} afresh.`;
  return `Yes: Shepherd merges at ${head} once CI is green.`;
}

function nextSteps(input: OwnerSectionInput, heads: Heads): string {
  return `${yesStep(heads)} No: the seat closes the PR${input.taskId ? ` and ${input.taskId} returns to the queue` : ""} with your note.`;
}

const bullets = (items: readonly string[]): string => items.map((item) => `- ${item}`).join("\n");

function renderMarkdown(input: OwnerSectionInput, heads: Heads, why: WhyAsked, recommended: Recommended): string {
  return [
    ...headerLines(input, heads, recommended),
    "",
    "#### What it does",
    whatItDoes(input),
    "",
    "#### Why it reaches you",
    whyItReaches(input, heads, why),
    "",
    "#### Pros",
    bullets(input.verdict?.ownerBrief?.pros ?? []),
    "",
    "#### Cons",
    bullets(consOf(input, heads)),
    "",
    "#### Before and after",
    visualsBlock(input),
    "",
    "#### If you say yes / If you say no",
    nextSteps(input, heads),
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
  const why = whyAsked(input.gate.rule, input.gate.reason, { ownerGateReason: input.ownerGateReason, mergeableState: input.gate.mergeableState });
  const heads = headsOf(input);
  const recommended = recommend(input, heads);
  const markdown = renderMarkdown(input, heads, why, recommended);
  return { markdown, ...harnessParts(input, markdown, recommended) };
}
