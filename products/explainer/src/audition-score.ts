import type { SpineCandidate } from "./audition-sample.js";
import { tagFacts, type CueId } from "./material-cues.js";
import type { MaterialFact } from "./material-facts.js";
import type { MaterialMap } from "./material-map.js";
import type { TypeProfile } from "./profile-schema.js";
import type { NarrativeStructure } from "./structure-schema.js";

/** The five code criteria of plan §A.3 step 4, each 0 to 1, and their mean. */
export interface CodeScores {
  fit: number;
  coverage: number;
  tension: number;
  range: number;
  freshness: number;
  total: number;
}

/** One earlier video of the profile's series, as much of it as freshness compares. */
export interface SeriesFingerprint {
  structure: string;
  signatureLayer: string;
}

export interface ScoreContext {
  map: MaterialMap;
  profile: TypeProfile;
  facts: readonly MaterialFact[];
  /** Earlier videos of the series, oldest first; empty until the PP-9 fingerprint (TP-4019) records them. */
  series: readonly SeriesFingerprint[];
}

const round = (n: number) => Math.round(n * 1000) / 1000;
const mean = (xs: readonly number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 1);

/** Predicate strength: the share of the fit's terms the signals meet, with a gap signal counting half. */
export function fitScore({ fit }: NarrativeStructure, map: MaterialMap): number {
  const met = (id: string) => {
    const holds = map.signals.find((row) => row.id === id)?.holds;
    return holds === null ? 0.5 : holds ? 1 : 0;
  };
  const runtimeS = map.profile.runtimeS;
  const bounded = fit.minRuntimeS !== undefined || fit.maxRuntimeS !== undefined;
  const terms = [
    ...fit.all.map(met),
    ...(fit.any.length ? [Math.max(...fit.any.map(met))] : []),
    ...fit.none.map((id) => 1 - met(id)),
    ...(bounded ? [runtimeS >= (fit.minRuntimeS ?? 0) && runtimeS <= (fit.maxRuntimeS ?? Number.POSITIVE_INFINITY) ? 1 : 0] : []),
  ];
  return round(mean(terms));
}

const placedFacts = (spine: SpineCandidate) => new Set([spine.hook.fact, ...spine.blocks.flatMap((b) => b.facts)]);

/** The cues that mark a fact as evidence for a profile coverage item; an item listed here is scored from cited facts. */
export const COVERAGE_CUES: Readonly<Record<string, readonly CueId[]>> = {
  "pain-or-anomaly": ["pain", "anomaly"],
  "mechanism-shown": ["mechanism", "flow"],
  method: ["mechanism"],
  "decisions-waiting": ["decision"],
  verdict: ["decision"],
  "adopt-adapt-avoid": ["decision"],
  risk: ["anomaly", "failure"],
  proof: ["experiment"],
  "result-with-grade": ["experiment"],
  purpose: ["purpose"],
  layout: ["layout"],
  "entry-point": ["entry"],
  "read-first": ["readFirst"],
  "key-features": ["parallel"],
  "merged-work": ["transition"],
};

export const COVERAGE_RULE = "coverage reads only the fact ids the hook and blocks cite: the share of anchor facts placed (the pack's P1 facts, or with none marked, the facts behind the holding signals the structure's fit reads), averaged with the share of coverage items a cited fact evidences by cue, over the items some fact in the pack evidences; covers tags are not scored";

/** The facts a spine must place: the pack's P1 facts, or with none marked, the facts its structure's fit rests on. */
export function anchorFacts(structure: NarrativeStructure, ctx: Pick<ScoreContext, "facts" | "map">): string[] {
  const p1 = ctx.facts.filter((fact) => /^p1$/i.test(fact.priority ?? "")).map((fact) => fact.id);
  if (p1.length) return p1;
  const read = new Set([...structure.fit.all, ...structure.fit.any]);
  return [...new Set(ctx.map.signals.filter((row) => row.holds === true && read.has(row.id)).flatMap((row) => row.facts))];
}

/** The share of anchor facts the spine cites, averaged with the share of evidenced coverage items its cited facts carry. */
export function coverageScore(spine: SpineCandidate, structure: NarrativeStructure, ctx: Pick<ScoreContext, "facts" | "map" | "profile">): number {
  const placed = placedFacts(spine);
  const anchors = anchorFacts(structure, ctx);
  const cues = tagFacts(ctx.facts);
  const evidence = (item: string) => COVERAGE_CUES[item]!.flatMap((cue) => cues(cue).map((hit) => hit.fact));
  const items = ctx.profile.coverage.filter((item) => Object.hasOwn(COVERAGE_CUES, item) && evidence(item).length > 0);
  const parts = [
    ...(anchors.length ? [anchors.filter((id) => placed.has(id)).length / anchors.length] : []),
    ...(items.length ? [items.filter((item) => evidence(item).some((id) => placed.has(id))).length / items.length] : []),
  ];
  return round(mean(parts));
}

/** Facts that carry stakes: tension material, or a fact behind a pending decision, an anomaly or a central problem. */
function stakeFacts(map: MaterialMap): Set<string> {
  const signals = map.signals.filter((row) => row.holds === true && ["decision-pending", "anomaly", "central-problem"].includes(row.id));
  return new Set([...map.material.tensions.map((hit) => hit.fact), ...signals.flatMap((row) => row.facts)]);
}

/** Each block's start as a share of the spine's length. */
function starts(spine: SpineCandidate): number[] {
  const total = spine.blocks.reduce((sum, b) => sum + b.seconds, 0);
  return spine.blocks.map((_, i) => spine.blocks.slice(0, i).reduce((sum, b) => sum + b.seconds, 0) / total);
}

/** The longest a block may run before it needs a re-hook: the profile's ceiling, or the longer band the profile gives the block itself. */
function reHookLimit(profile: TypeProfile, block: string): number {
  const band = profile.structure.blocks.find((b) => b.id === block)?.seconds;
  return Math.max(profile.pacing.reHookS[1], band?.[1] ?? 0);
}

export const REHOOK_RULE = "each block, scaled to the profile's target runtime, runs no longer than the profile's re-hook ceiling, or than the block's own band when the profile bands it longer: a long block (supports, countdown, clues) is a run of items, each its own re-hook";

/** DIR §4's tension curve over the spine: stake by 15 %, complication by 25 %, a re-hook in the profile's band, payoff set up by 40 %. */
export function tensionChecks(spine: SpineCandidate, ctx: Pick<ScoreContext, "map" | "profile">): Record<string, boolean> {
  const stakes = stakeFacts(ctx.map);
  const at = starts(spine);
  const staked = (i: number) => spine.blocks[i]!.facts.some((id) => stakes.has(id));
  const total = spine.blocks.reduce((sum, b) => sum + b.seconds, 0);
  const reHooked = spine.blocks.every((b) => (b.seconds / total) * ctx.profile.runtime.targetS <= reHookLimit(ctx.profile, b.id));
  const payoffAt = at[spine.blocks.findIndex((b) => b.id === spine.payoff)] ?? 1;
  return {
    "stake by 15%": stakes.has(spine.hook.fact) || at.some((s, i) => s <= 0.15 && staked(i)),
    "complication by 25%": at.some((s, i) => i > 0 && s <= 0.25 && staked(i)),
    [`re-hook within ${ctx.profile.pacing.reHookS[1]} s or the block's band`]: reHooked,
    "payoff set up by 40%": payoffAt <= 0.4,
  };
}

/** Visual range until the resolver (PP-6) can say what it would draw: distinct lead beats over blocks. */
export const rangeScore = (spine: SpineCandidate): number => round(new Set(spine.blocks.map((b) => b.beat)).size / spine.blocks.length);

/** The share of the profile's must-vary fields a spine can name that differ from every video in the series window. */
export function freshnessScore(spine: SpineCandidate, ctx: Pick<ScoreContext, "profile" | "series">): number {
  const window = ctx.series.slice(-ctx.profile.variety.window);
  const norm = (text: string) => text.trim().toLowerCase();
  const fields = [
    ...(ctx.profile.series.mustVary.includes("structure") ? [(v: SeriesFingerprint) => v.structure === spine.structure] : []),
    ...(ctx.profile.series.mustVary.includes("signature-layer") ? [(v: SeriesFingerprint) => norm(v.signatureLayer) === norm(spine.signatureLayer)] : []),
  ];
  if (window.length === 0 || fields.length === 0) return 1;
  return round(fields.filter((repeats) => !window.some(repeats)).length / fields.length);
}

export function codeScores(spine: SpineCandidate, structure: NarrativeStructure, ctx: ScoreContext): { scores: CodeScores; tension: Record<string, boolean> } {
  const tension = tensionChecks(spine, ctx);
  const parts = {
    fit: fitScore(structure, ctx.map),
    coverage: coverageScore(spine, structure, ctx),
    tension: round(mean(Object.values(tension).map((ok) => (ok ? 1 : 0)))),
    range: rangeScore(spine),
    freshness: freshnessScore(spine, ctx),
  };
  return { scores: { ...parts, total: round(mean(Object.values(parts))) }, tension };
}

export interface Ranked {
  id: string;
  total: number;
  likelihood: number;
}

/** The pick rule: the highest code total; a tie goes to the higher stated likelihood, then to the earlier slot. */
export const PICK_RULE = "highest code total (mean of fit, coverage, tension, range, freshness); ties go to the higher stated likelihood, then the earlier slot; the cold-viewer rubric is recorded beside it and never picks";

export function pickCandidate(ranked: readonly Ranked[]): { pick: Ranked; runnerUp: Ranked; margin: number } {
  if (ranked.length < 2) throw new Error(`audition: a pick needs at least 2 scored candidates, got ${ranked.length}`);
  const order = ranked.map((r, i) => ({ r, i })).sort((a, b) => b.r.total - a.r.total || b.r.likelihood - a.r.likelihood || a.i - b.i);
  const [pick, runnerUp] = [order[0]!.r, order[1]!.r];
  return { pick, runnerUp, margin: round(pick.total - runnerUp.total) };
}
