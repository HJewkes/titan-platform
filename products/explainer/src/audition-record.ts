import { FALLBACK_RULE, UNDECIDED_RULE, type AuditionPool, type SlotBasis } from "./audition-pool.js";
import type { SpineCandidate } from "./audition-sample.js";
import { PICK_RULE, pickCandidate, type CodeScores } from "./audition-score.js";
import { rubricNote, type ColdRubricResult, type RubricCandidate } from "./eval-cold-rubric.js";
import { canonicalSha } from "./eval-store.js";
import type { MaterialMap } from "./material-map.js";

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
  /** The cold-viewer rows J8 to J12, reported only; null when the judge could not score. */
  rubric: ColdRubricResult | null;
}

export interface AuditionRecord {
  schema: "audition/v1";
  materialMap: string;
  profile: MaterialMap["profile"];
  k: number;
  /** The step stops at the storyboard: no spine past these candidates is written and nothing is rendered. */
  storyboardOnly: true;
  rules: { pick: string; undecided: string; fallback: string };
  fallback: AuditionPool["fallback"];
  undecided: AuditionPool["undecided"];
  candidates: AuditionCandidate[];
  pick: { candidate: string; structure: string; system: string | null; total: number };
  runnerUp: { candidate: string; structure: string; system: string | null; total: number };
  margin: number;
  rubricError?: string;
}

/** A candidate as the cold viewer meets it: the hook with its signature layer on screen, then each block's question. */
export function rubricCandidate(id: string, spine: SpineCandidate): RubricCandidate {
  const hook = { id: `${id}-hook`, spoken: spine.hook.line, screen: [spine.signatureLayer] };
  const blocks = spine.blocks.map((block) => ({ id: `${id}-${block.id}`, spoken: block.question, screen: [block.beat] }));
  return { id, sha: canonicalSha(spine), beats: [hook, ...blocks] };
}

interface RecordInput {
  mapSha: string;
  map: MaterialMap;
  k: number;
  pool: AuditionPool;
  candidates: AuditionCandidate[];
  rubricError?: string;
}

export function auditionRecord(input: RecordInput): AuditionRecord {
  const { candidates } = input;
  const ranked = candidates.map((c) => ({ id: c.id, total: c.scores.total, likelihood: c.likelihood }));
  const { pick, runnerUp, margin } = pickCandidate(ranked);
  const named = (id: string) => {
    const c = candidates.find((x) => x.id === id)!;
    return { candidate: c.id, structure: c.structure, system: c.system, total: c.scores.total };
  };
  return {
    schema: "audition/v1", materialMap: input.mapSha, profile: input.map.profile, k: input.k, storyboardOnly: true,
    rules: { pick: PICK_RULE, undecided: UNDECIDED_RULE, fallback: FALLBACK_RULE },
    fallback: input.pool.fallback, undecided: input.pool.undecided, candidates,
    pick: named(pick.id), runnerUp: named(runnerUp.id), margin,
    ...(input.rubricError ? { rubricError: input.rubricError } : {}),
  };
}

const label = (n: { candidate: string; structure: string; system: string | null; total: number }) => `${n.candidate} ${n.structure}${n.system ? `/${n.system}` : ""} (${n.total})`;

/** The stage notes, which the run report and the render notes carry: the pick, the runner-up by name, and why the pool is what it is. */
export function auditionNotes(record: AuditionRecord): string[] {
  const rubric = record.candidates.map((c) => `${c.id}: ${c.rubric ? rubricNote(c.rubric) : `cold rubric (reported only): not scored${record.rubricError ? `, ${record.rubricError}` : ""}`}`);
  return [
    `audition pick: ${label(record.pick)}; runner-up: ${label(record.runnerUp)}; margin ${record.margin}`,
    ...(record.fallback ? [`fallback to ${record.fallback.structure}: ${record.fallback.reason}`] : []),
    ...record.undecided.map((u) => `undecided ${u.structure} on ${u.gaps.join(", ")}: ${u.used ? "sampled to top up the pool" : "left out, k structures fit"}`),
    ...rubric,
  ];
}
