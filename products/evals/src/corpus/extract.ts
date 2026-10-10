import { classifyPr, DEFAULT_CLASS_RULES, type ClassRules, type PrTouch, type ReviewClass } from "@titan-design/review-panel";
import { z } from "zod";
import { citedPaths, citesPath } from "./cited-paths.js";
import type { CostOf, ReviewCost } from "./cost.js";
import { prKey, type FactoryFacts, type HeadVerdict } from "./factory-facts.js";
import type { GitPort } from "./git.js";
import { deriveLabel, type CorpusLabel, type RawLabels } from "./labels.js";
import { mergeOutcome, type MergeOutcome } from "./merge-outcome.js";

export interface CorpusRow {
  repo: string;
  pr: number;
  head: string;
  runId: string;
  task: string | null;
  kind: string | null;
  policy: string | null;
  verdict: "MERGE" | "FIX_FIRST";
  step: HeadVerdict["step"];
  verdictAt: string;
  reviewer: { profile: string | null; agentId: string | null; sessionId: string | null };
  closer: string | null;
  locator: unknown;
  findings: string | null;
  citedPaths: string[];
  class: ReviewClass | null;
  touches: PrTouch[] | null;
  cost: ReviewCost | null;
  latencyMs: number | null;
  mergeSha: string | null;
  nextHead: string | null;
  labels: RawLabels;
  overrideReason: string | null;
  label: CorpusLabel;
}

export interface ExtractDeps {
  facts: FactoryFacts;
  /** The clone for `owner/repo`; undefined leaves that repo's git-derived fields null. */
  gitFor(repo: string): GitPort | undefined;
  costOf: CostOf;
  now: Date;
  rules?: ClassRules;
}

const TranscriptSchema = z.looseObject({ source: z.looseObject({ path: z.string(), namespace: z.string() }) });
const CLOSER = /^\s*Closer:\s*(.+?)\s*$/m;

interface PrContext {
  git: GitPort | undefined;
  mergeSha: string | null;
  /** True when Shepherd landed the merge, so its post-merge main read was recorded; a squash found on main has none. */
  landedByShepherd: boolean;
  merge: MergeOutcome;
  /** The PR's reviewed heads in verdict order, then the landed head if it was never reviewed. */
  heads: string[];
}

function prHeads(facts: FactoryFacts, key: string): string[] {
  const heads = [...new Set(facts.verdicts.filter((verdict) => prKey(verdict.repo, verdict.pr) === key).map((verdict) => verdict.result.head))];
  const landed = facts.landings.get(key)?.headSha;
  return landed && !heads.includes(landed) ? [...heads, landed] : heads;
}

/** A PR merged outside Shepherd's landing step still shows on main as GitHub's squash subject, `<title> (#<pr>)`. */
function squashMergeOf(git: GitPort, pr: number): string | null {
  return git.mainLog().find((commit) => commit.subject.endsWith(`(#${pr})`))?.sha ?? null;
}

function prContext(deps: ExtractDeps, verdict: HeadVerdict): PrContext {
  const key = prKey(verdict.repo, verdict.pr);
  const git = deps.gitFor(verdict.repo);
  const landed = deps.facts.landings.get(key)?.mergeSha;
  const mergeSha = landed ?? (git ? squashMergeOf(git, verdict.pr) : null);
  const merge = git && mergeSha ? mergeOutcome(git, mergeSha) : { revert: null, laterFix: null };
  return { git, mergeSha, landedByShepherd: landed !== undefined, merge, heads: prHeads(deps.facts, key) };
}

function classOf(git: GitPort | undefined, verdict: HeadVerdict, kind: string | null, rules: ClassRules): Pick<CorpusRow, "class" | "touches"> {
  const head = verdict.result.head;
  const changedFiles = git?.hasCommit(head) ? git.changedFiles(head) : undefined;
  if (!changedFiles) return { class: null, touches: null };
  const pr = classifyPr({ repo: verdict.repo, pr: verdict.pr, head, base: "", changedFiles, ...(kind !== null && { kind }) }, rules);
  return { class: pr.class, touches: [...pr.touches] };
}

function nextHeadOf(context: PrContext, head: string): string | null {
  const index = context.heads.indexOf(head);
  return index >= 0 ? (context.heads[index + 1] ?? null) : null;
}

function fixerChangedCited(context: PrContext, head: string, next: string | null, cited: readonly string[]): boolean | null {
  if (cited.length === 0 || next === null || !context.git?.hasCommit(head) || !context.git.hasCommit(next)) return null;
  const changed = context.git.pathsBetween(head, next);
  return changed ? changed.some((path) => cited.some((citation) => citesPath(citation, path))) : null;
}

function isOverride(deps: ExtractDeps, verdict: HeadVerdict): boolean {
  const decision = deps.facts.ownerDecisions.get(verdict.result.head)?.decision;
  return verdict.result.verdict === "FIX_FIRST" ? decision === "merge" : decision === "abandon";
}

/** No red record is evidence of green only for a merge Shepherd landed and then read main for. */
function mainRed(deps: ExtractDeps, context: PrContext): boolean | null {
  if (!context.mergeSha) return null;
  if (deps.facts.redMerges.has(context.mergeSha)) return true;
  return context.landedByShepherd ? false : null;
}

function rawLabels(deps: ExtractDeps, context: PrContext, verdict: HeadVerdict, cited: readonly string[]): RawLabels {
  const isFixFirst = verdict.result.verdict === "FIX_FIRST";
  return {
    revert: context.merge.revert,
    "main-red": mainRed(deps, context),
    "later-fix": context.merge.laterFix,
    "owner-override": isOverride(deps, verdict),
    "fixer-changed-cited-paths": isFixFirst ? fixerChangedCited(context, verdict.result.head, nextHeadOf(context, verdict.result.head), cited) : null,
  };
}

const latencyOf = (verdict: HeadVerdict): number | null =>
  verdict.dispatchedAt !== undefined && Number.isFinite(verdict.dispatchedAt) ? Date.parse(verdict.verdictAt) - verdict.dispatchedAt : null;

async function costOf(deps: ExtractDeps, verdict: HeadVerdict): Promise<ReviewCost | null> {
  const transcript = TranscriptSchema.safeParse(verdict.result.locator);
  return transcript.success ? ((await deps.costOf(transcript.data.source, verdict.verdictAt)) ?? null) : null;
}

function verdictFields(verdict: HeadVerdict): Pick<CorpusRow, "verdict" | "step" | "verdictAt" | "reviewer" | "closer" | "locator" | "findings"> {
  const { result } = verdict;
  const text = result.text ?? "";
  return {
    verdict: result.verdict,
    step: verdict.step,
    verdictAt: verdict.verdictAt,
    reviewer: { profile: result.reviewerProfile ?? null, agentId: result.reviewer?.agentId ?? null, sessionId: result.reviewer?.sessionId ?? null },
    closer: CLOSER.exec(text)?.[1] ?? null,
    locator: result.locator ?? null,
    findings: result.verdict === "FIX_FIRST" ? text : null,
  };
}

async function rowFor(deps: ExtractDeps, verdict: HeadVerdict, context: PrContext): Promise<CorpusRow> {
  const registration = deps.facts.registrations.get(verdict.runId);
  const kind = registration?.kind ?? null;
  const cited = verdict.result.verdict === "FIX_FIRST" ? citedPaths(verdict.result.text ?? "") : [];
  const labels = rawLabels(deps, context, verdict, cited);
  const overrideReason = labels["owner-override"] ? (deps.facts.ownerDecisions.get(verdict.result.head)?.reason ?? null) : null;
  const label = deriveLabel({ verdict: verdict.result.verdict, verdictAt: verdict.verdictAt, now: deps.now, merged: context.mergeSha !== null, labels, overrideReason });
  return {
    repo: verdict.repo,
    pr: verdict.pr,
    head: verdict.result.head,
    runId: verdict.runId,
    task: registration?.task ?? null,
    kind,
    policy: registration?.policy ?? null,
    ...verdictFields(verdict),
    citedPaths: cited,
    ...classOf(context.git, verdict, kind, deps.rules ?? DEFAULT_CLASS_RULES),
    cost: await costOf(deps, verdict),
    latencyMs: latencyOf(verdict),
    mergeSha: context.mergeSha,
    nextHead: nextHeadOf(context, verdict.result.head),
    labels,
    overrideReason,
    label,
  };
}

/** One row per (repo, pr, head) that had a verdict, in verdict order. */
export async function extractCorpus(deps: ExtractDeps): Promise<CorpusRow[]> {
  const contexts = new Map<string, PrContext>();
  const rows: CorpusRow[] = [];
  for (const verdict of deps.facts.verdicts) {
    const key = prKey(verdict.repo, verdict.pr);
    const context = contexts.get(key) ?? prContext(deps, verdict);
    contexts.set(key, context);
    rows.push(await rowFor(deps, verdict, context));
  }
  return rows;
}
