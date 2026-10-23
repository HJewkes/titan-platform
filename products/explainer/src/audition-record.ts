import { FALLBACK_RULE, UNDECIDED_RULE, type AuditionPool, type SlotBasis } from "./audition-pool.js";
import type { SpineCandidate } from "./audition-sample.js";
import { COVERAGE_RULE, PICK_RULE, REHOOK_RULE, pickCandidate, type CodeScores } from "./audition-score.js";
import { rubricNote, type ColdRubricResult, type RubricCandidate } from "./eval-cold-rubric.js";
import { MIN_QUOTE_WORDS } from "./eval-evidence.js";
import { canonicalSha } from "./eval-store.js";
import type { MaterialMap } from "./material-map.js";
import type { TypeProfile } from "./profile-schema.js";

/** A cold-viewer row the storyboard cannot be judged on, and why; it is left out of the rubric rather than voided. */
export interface SkippedRow {
  dim: "J12";
  reason: string;
}

/** Script chapter n plays block n of the picked spine; `block` is null when the profile names no block with that id. */
export interface ChapterBlock {
  chapter: string;
  block: string | null;
}

/** One sampled spine with every score it got; the audition keeps all of them, picked or not. */
export interface AuditionCandidate {
  id: string;
  structure: string;
  system: string | null;
  basis: SlotBasis;
  likelihood: number;
  spine: SpineCandidate;
  scores: CodeScores;
  tension: Record<string, boolean>;
  /** The cold-viewer rows J8 to J12, reported only, less any skipped row; null when the judge could not score. */
  rubric: ColdRubricResult | null;
  skipped: SkippedRow[];
}

export interface AuditionRecord {
  schema: "audition/v1";
  materialMap: string;
  profile: MaterialMap["profile"];
  k: number;
  /** The step stops at the storyboard: no spine past these candidates is written and nothing is rendered. */
  storyboardOnly: true;
  rules: { pick: string; coverage: string; reHook: string; undecided: string; fallback: string };
  fallback: AuditionPool["fallback"];
  undecided: AuditionPool["undecided"];
  candidates: AuditionCandidate[];
  /** `chapters` lets per-block word caps apply downstream (TP-2614): they read a chapter's profile block. */
  pick: { candidate: string; structure: string; system: string | null; total: number; chapters: ChapterBlock[] };
  runnerUp: { candidate: string; structure: string; system: string | null; total: number };
  margin: number;
  rubricError?: string;
}

/** A candidate as the cold viewer meets it: the hook with its signature layer on screen, then each block's question. */
export function rubricCandidate(id: string, spine: SpineCandidate): RubricCandidate {
  const hook = { id: `${id}-hook`, spoken: spine.hook.line, screen: [spine.signatureLayer] };
  const blocks = spine.blocks.map((block) => ({ id: `${id}-${block.id}`, spoken: block.question, screen: [] }));
  return { id, sha: canonicalSha(spine), beats: [hook, ...blocks] };
}

const quotable = (text: string) => text.trim().split(/\s+/).length >= MIN_QUOTE_WORDS;

/** Visual consistency compares looks across beats; a storyboard with fewer than two quotable visuals gives J12 nothing to judge. */
export function skippedRows(candidate: RubricCandidate): SkippedRow[] {
  const shown = candidate.beats.filter((beat) => beat.screen.some(quotable)).length;
  return shown >= 2 ? [] : [{ dim: "J12", reason: `the storyboard shows a quotable visual on ${shown} beat${shown === 1 ? "" : "s"}; visual consistency needs 2 to compare` }];
}

/** The rubric without its skipped rows, so a row the storyboard cannot carry is never read as a void score. */
export function withoutSkipped(rubric: ColdRubricResult | null, skipped: readonly SkippedRow[]): ColdRubricResult | null {
  return rubric && { ...rubric, dims: rubric.dims.filter((d) => !skipped.some((s) => s.dim === d.dim)) };
}

export function chapterBlocks(spine: SpineCandidate, profile: TypeProfile): ChapterBlock[] {
  const named = new Set(profile.structure.blocks.map((block) => block.id));
  return spine.blocks.map((block, i) => ({ chapter: `ch${i + 1}`, block: named.has(block.id) ? block.id : null }));
}

interface RecordInput {
  mapSha: string;
  map: MaterialMap;
  profile: TypeProfile;
  k: number;
  pool: AuditionPool;
  candidates: AuditionCandidate[];
  rubricError?: string;
}

export function auditionRecord(input: RecordInput): AuditionRecord {
  const { candidates } = input;
  const ranked = candidates.map((c) => ({ id: c.id, total: c.scores.total, likelihood: c.likelihood }));
  const { pick, runnerUp, margin } = pickCandidate(ranked);
  const of = (id: string) => candidates.find((x) => x.id === id)!;
  const named = (id: string) => ({ candidate: id, structure: of(id).structure, system: of(id).system, total: of(id).scores.total });
  return {
    schema: "audition/v1", materialMap: input.mapSha, profile: input.map.profile, k: input.k, storyboardOnly: true,
    rules: { pick: PICK_RULE, coverage: COVERAGE_RULE, reHook: REHOOK_RULE, undecided: UNDECIDED_RULE, fallback: FALLBACK_RULE },
    fallback: input.pool.fallback, undecided: input.pool.undecided, candidates,
    pick: { ...named(pick.id), chapters: chapterBlocks(of(pick.id).spine, input.profile) }, runnerUp: named(runnerUp.id), margin,
    ...(input.rubricError ? { rubricError: input.rubricError } : {}),
  };
}

const label = (n: AuditionRecord["runnerUp"]) => `${n.candidate} ${n.structure}${n.system ? `/${n.system}` : ""} (${n.total})`;

/** The stage notes, which the run report and the render notes carry: the pick, the runner-up by name, and why the pool is what it is. */
export function auditionNotes(record: AuditionRecord): string[] {
  const skips = (c: AuditionCandidate) => c.skipped.map((s) => `; ${s.dim} skipped: ${s.reason}`).join("");
  const rubric = record.candidates.map((c) => `${c.id}: ${c.rubric ? rubricNote(c.rubric) : `cold rubric (reported only): not scored${record.rubricError ? `, ${record.rubricError}` : ""}`}${skips(c)}`);
  return [
    `audition pick: ${label(record.pick)}; runner-up: ${label(record.runnerUp)}; margin ${record.margin}`,
    `chapters: ${record.pick.chapters.map((c) => `${c.chapter}=${c.block ?? "no profile block"}`).join(", ")}`,
    ...(record.fallback ? [`fallback to ${record.fallback.structure}: ${record.fallback.reason}`] : []),
    ...record.undecided.map((u) => `undecided ${u.structure} on ${u.gaps.join(", ")}: ${u.used ? "sampled to top up the pool" : "left out, k structures fit"}`),
    ...rubric,
  ];
}
