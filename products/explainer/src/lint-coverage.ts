import { z } from "zod";
import type { L0Check, L0Result } from "./eval-l0.js";
import { claimText, type GatheredFact } from "./lint-claims.js";
import { ruleRow } from "./lint-text.js";
import type { ScriptBeat, ScriptV1 } from "./script-schema.js";

export const COVERAGE_CHECK_ID = "Q-E21";
export const REFLECTION_CHECK_ID = "Q-E22";

/** The goal-walk chapters the two checks read: chapter ids are the structure's block ids. */
export const LANES_CHAPTER = "lanes";
export const REFLECTION_CHAPTER = "reflection";
export const SLOWDOWN_PREFIX = "slow/";
export const PRIORITY_PREFIX = "next/";

/** The slice of a daily gather's `coverage.json` (lane-rollup.ts `Coverage`) the coverage check reads. */
export const CoverageSchema = z.object({
  merged: z.number().int().nonnegative(),
  lanes: z.array(z.object({ id: z.string(), label: z.string(), rollup: z.string(), merged: z.number().int().nonnegative(), named: z.array(z.string()) })),
  prs: z.array(z.object({ pr: z.string(), lane: z.string(), thread: z.string(), named: z.boolean() })),
});
export type CoverageManifest = z.infer<typeof CoverageSchema>;

export const parseCoverage = (text: string): CoverageManifest => CoverageSchema.parse(JSON.parse(text));

/** A lane whose PRs are neither all cited nor counted, or a named PR no beat cites. */
export type CoverageFinding =
  | { kind: "lane"; lane: string; rollup: string; merged: number; uncited: number }
  | { kind: "named"; lane: string; pr: string };

const citedIds = (beats: readonly ScriptBeat[]): Set<string> => new Set(beats.flatMap((beat) => beat.fact_ids));

// The total as a whole number: "2." ends a sentence, while "1.2" and "12" are other numbers.
const beatSays = (beat: ScriptBeat, n: number): boolean =>
  [beat.spoken, ...beat.visual.labels].some((text) => new RegExp(`(?<!\\d|\\d\\.)${n}(?!\\d|\\.\\d)`).test(claimText(text)));

/** A lanes beat cites the lane's rollup fact and says or shows its total. */
const counted = (script: ScriptV1, rollup: string, merged: number): boolean =>
  script.beats.some((beat) => beat.chapter === LANES_CHAPTER && beat.fact_ids.includes(rollup) && beatSays(beat, merged));

export function coverageFindings(script: ScriptV1, coverage: CoverageManifest): CoverageFinding[] {
  const cited = citedIds(script.beats);
  const lanes = coverage.lanes.flatMap((lane): CoverageFinding[] => {
    const uncited = coverage.prs.filter((entry) => entry.lane === lane.id && !cited.has(entry.pr)).length;
    if (uncited === 0 || counted(script, lane.rollup, lane.merged)) return [];
    return [{ kind: "lane", lane: lane.id, rollup: lane.rollup, merged: lane.merged, uncited }];
  });
  const named = coverage.prs.filter((entry) => entry.named && !cited.has(entry.pr)).map((entry): CoverageFinding => ({ kind: "named", lane: entry.lane, pr: entry.pr }));
  return [...lanes, ...named];
}

const notApplicable = (id: string): L0Result[] => [ruleRow(id, { value: 0, threshold: 0, pass: true, severity: "warning", mode: "tagged" })];

/** Q-E21 over a daily gather's coverage manifest; without one (any other profile) the row is a passing warning. */
export function coverageCheckWith(coverage?: CoverageManifest): L0Check {
  return ({ script }) => {
    if (!coverage) return notApplicable(COVERAGE_CHECK_ID);
    const findings = coverageFindings(script, coverage);
    const lanes = new Set(findings.filter((f) => f.kind === "lane").map((f) => f.lane));
    const beats = script.beats.filter((beat) => beat.chapter === LANES_CHAPTER && lanes.size > 0).map((beat) => beat.id);
    return [ruleRow(COVERAGE_CHECK_ID, { value: findings.length, threshold: 0, pass: findings.length === 0, mode: "tagged", beats })];
  };
}

/** A reflection beat that is not a priority must cite the slowdown fact it answers. */
export const uncitedReflections = (script: ScriptV1): ScriptBeat[] =>
  script.beats.filter(
    (beat) => beat.chapter === REFLECTION_CHAPTER && !beat.fact_ids.some((id) => id.startsWith(SLOWDOWN_PREFIX) || id.startsWith(PRIORITY_PREFIX)),
  );

/** Q-E22 runs when the facts hold a slowdown and the script has a reflection chapter; otherwise a passing warning. */
export function reflectionCheckWith(facts?: readonly GatheredFact[]): L0Check {
  return ({ script }) => {
    const slowdowns = facts?.some((fact) => fact.id.startsWith(SLOWDOWN_PREFIX)) ?? false;
    if (!slowdowns || !script.chapters.some((chapter) => chapter.id === REFLECTION_CHAPTER)) return notApplicable(REFLECTION_CHECK_ID);
    const beats = uncitedReflections(script).map((beat) => beat.id);
    return [ruleRow(REFLECTION_CHECK_ID, { value: beats.length, threshold: 0, pass: beats.length === 0, mode: "tagged", beats })];
  };
}

/** The registered defaults: no manifest or facts reach the shared L0 pass, so both report that they did not run. */
export const coverageCheck: L0Check = coverageCheckWith();
export const reflectionCheck: L0Check = reflectionCheckWith();

/** `checks` with the registered no-input Q-E21 and Q-E22 swapped for ones that read the gather's manifest and facts. */
export const withCoverage = (checks: readonly L0Check[], coverage: CoverageManifest | undefined, facts: readonly GatheredFact[] | undefined): readonly L0Check[] =>
  checks.map((check) => (check === coverageCheck ? coverageCheckWith(coverage) : check === reflectionCheck ? reflectionCheckWith(facts) : check));
