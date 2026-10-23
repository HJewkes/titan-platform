import { tmpdir } from "node:os";
import { agentRunner, type StepRunOutcome } from "@titan-design/workflow";
import { auditionPool, type AuditionPool } from "../audition-pool.js";
import { auditionNotes, auditionRecord, rubricCandidate, type AuditionCandidate } from "../audition-record.js";
import { checkSample, samplePrompt, sampleRetryPrompt, slotBlocks, type SampleContext, type SpineCandidate } from "../audition-sample.js";
import { codeScores, type ScoreContext } from "../audition-score.js";
import { loadDoctrine } from "../doctrine-load.js";
import { readColdRubric, scoreCandidates, type ColdRubricResult } from "../eval-cold-rubric.js";
import { createJudgeHarness, type JudgeConfig } from "../eval-harness.js";
import { canonicalJson } from "../eval-store.js";
import { parseFacts, type MaterialFact } from "../material-facts.js";
import { buildMaterialMap, registrySha, type MaterialMap } from "../material-map.js";
import { loadProfiles, profileFor, structureFor, type ProfileSet } from "../profile-load.js";
import type { TypeProfile } from "../profile-schema.js";
import { sha256 } from "./artifacts.js";
import { stageUsage, StageFailure, type HarnessFor, type ModelStageInput, type RunnerFor } from "./model-stages.js";
import { addUsage, NO_USAGE, type StageOutcome, type StageUsage } from "./records.js";

/** What the audition's stage key covers beyond the facts sha: the doctrine it reads, the sampling model and the rubric judge. */
interface AuditionConfig {
  profile: { type: string; version: string; sha: string };
  structures: string;
  model: string;
  judge: JudgeConfig;
}

/** Read when the spec is built, so a profile or structure edit is a new key and never a stale cache hit. */
export function auditionConfig(type: string, models: { model: string; judge: JudgeConfig }): AuditionConfig {
  const set = loadProfiles();
  const profile = profileFor(set, type);
  return { profile: { type, version: profile.version, sha: sha256(canonicalJson(profile)) }, structures: registrySha(set.structures), ...models };
}

export interface AuditionDeps {
  runnerFor?: RunnerFor;
  harnessFor?: HarnessFor;
  signal?: AbortSignal;
}

/** The sampling call's own ceiling; plan §A.3 prices it at $0.05 to $0.15 at sonnet. */
export const SAMPLE_CALL_USD = 1;

function mapSummary(map: MaterialMap): string[] {
  const holding = map.signals.filter((row) => row.holds === true).map((row) => row.id);
  const outside = map.fits.filter((row) => row.fit === "fits" && !row.allowed).map((row) => row.structure);
  const undecided = map.fits.filter((row) => row.fit === "undecided").map((row) => row.structure);
  return [
    `${map.facts.count} facts; signals holding: ${holding.join(", ") || "none"}; gaps: ${map.gaps.join(", ") || "none"}`,
    `candidates (fit and allowed by ${map.profile.type}): ${map.candidates.join(", ") || "none"}`,
    `fit outside the profile: ${outside.join(", ") || "none"}; undecided on a gap: ${undecided.join(", ") || "none"}`,
  ];
}

/** One sampling call for every slot, and one retry naming the issues when the reply cannot stand as the candidates. */
async function sampleSpines(call: (prompt: string) => Promise<StepRunOutcome>, ctx: SampleContext): Promise<{ spines: SpineCandidate[]; usage: StageUsage; retries: number }> {
  const prompt = samplePrompt(ctx);
  let usage = NO_USAGE;
  let issues: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const outcome = await call(attempt === 0 ? prompt : sampleRetryPrompt(prompt, issues));
    usage = addUsage(usage, stageUsage(outcome.usage));
    if (!outcome.ok) throw new StageFailure(`audition: sampling call failed: ${outcome.error}`, usage, attempt);
    const checked = checkSample(ctx, outcome.output);
    if (checked.spines) return { spines: checked.spines, usage, retries: attempt };
    issues = checked.issues;
  }
  throw new StageFailure(`audition: the sampled spines were rejected twice: ${issues.slice(0, 5).join("; ")}`, usage, 1);
}

function sampleContext(set: ProfileSet, profile: TypeProfile, map: MaterialMap, facts: readonly MaterialFact[], pool: AuditionPool): SampleContext {
  const blocks = new Map(pool.slots.map((slot) => [slot.structure, slotBlocks(profile, structureFor(set.structures, slot.structure))]));
  return { slots: pool.slots, blocks, structures: set.structures, profile, map, facts };
}

/** The reported-only cold-viewer rows on every candidate; a judge that cannot score leaves them null, never a pick input. */
async function coldRubric(spines: readonly SpineCandidate[], config: AuditionConfig, deps: AuditionDeps): Promise<{ results: (ColdRubricResult | null)[]; error?: string }> {
  const harness = (deps.harnessFor ?? createJudgeHarness)(config.judge);
  try {
    const candidates = spines.map((s, i) => rubricCandidate(`c${i + 1}`, s));
    const scored = await scoreCandidates(candidates, { rubric: readColdRubric(), series: [], judge: config.judge, harness, run: 1 });
    return { results: scored.map((s) => s.rubric) };
  } catch (error) {
    return { results: spines.map(() => null), error: error instanceof Error ? error.message : String(error) };
  }
}

const spendUsage = ({ spend }: ColdRubricResult): StageUsage => ({ usd: spend.usd, inputTokens: spend.tokensIn, outputTokens: spend.tokensOut, cacheReadTokens: 0, calls: 1 });
const rubricUsage = (results: readonly (ColdRubricResult | null)[]): StageUsage =>
  results.filter((r) => r !== null).reduce<StageUsage>((sum, r) => addUsage(sum, spendUsage(r)), NO_USAGE);

function candidatesOf(spines: readonly SpineCandidate[], pool: AuditionPool, set: ProfileSet, ctx: ScoreContext, rubric: readonly (ColdRubricResult | null)[]): AuditionCandidate[] {
  return spines.map((spine, i) => {
    const slot = pool.slots[i]!;
    const { scores, tension } = codeScores(spine, structureFor(set.structures, slot.structure), ctx);
    return { id: `c${i + 1}`, structure: slot.structure, system: slot.system, basis: slot.basis, likelihood: spine.likelihood, spine, scores, tension, rubric: rubric[i] ?? null };
  });
}

function caller(input: ModelStageInput, config: AuditionConfig, deps: AuditionDeps): (prompt: string) => Promise<StepRunOutcome> {
  const maxBudgetUsd = Math.max(0.01, Math.min(SAMPLE_CALL_USD, input.remainingUsd));
  const runner = (deps.runnerFor ?? agentRunner)({ cwd: tmpdir(), maxTurns: 1, maxBudgetUsd, defaults: { harness: "claude-print", model: config.model } });
  const signal = deps.signal ?? new AbortController().signal;
  return (prompt) => runner.run({ runId: input.from.runId, workflowName: "explainer-video", stepId: "audition", iteration: 0, prompt, signal });
}

/**
 * The audition (plan §A.3): the material map, a pool of structures, k spines from one verbalized-sampling call, each
 * scored by code and by the reported-only cold-viewer rubric, and the agent's pick by the code total. It stops at the
 * storyboard: `audition.json` keeps every candidate, the pick, the margin and the runner-up, and nothing is rendered.
 */
export async function runAuditionStage(input: ModelStageInput, config: AuditionConfig, deps: AuditionDeps = {}): Promise<StageOutcome> {
  const now = auditionConfig(config.profile.type, { model: config.model, judge: config.judge });
  if (canonicalJson(now) !== canonicalJson(config)) throw new Error(`audition: the profile or structure registry changed since this stage was keyed; build a new spec`);
  const factsSha = input.artifacts.facts;
  if (factsSha === undefined) throw new Error(`stage audition needs artifact "facts", which no earlier stage produced`);
  const { format, facts } = parseFacts(input.store.readText(factsSha));
  const set = loadProfiles();
  const profile = profileFor(set, config.profile.type);
  const map = buildMaterialMap({ factsSha, format, facts, profile, structures: set.structures, vocabulary: loadDoctrine().vocabulary.signals });
  const mapSha = input.store.putText(`${JSON.stringify(map, null, 2)}\n`, "material-map", input.from);
  const pool = auditionPool(map, profile);
  const sampled = await sampleSpines(caller(input, config, deps), sampleContext(set, profile, map, facts, pool));
  const rubric = await coldRubric(sampled.spines, config, deps);
  const candidates = candidatesOf(sampled.spines, pool, set, { map, profile, facts, series: [] }, rubric.results);
  const record = auditionRecord({ mapSha, map, k: profile.audition.k, pool, candidates, ...(rubric.error ? { rubricError: rubric.error } : {}) });
  const auditionSha = input.store.putText(`${JSON.stringify(record, null, 2)}\n`, "audition", input.from);
  const scored = candidates.length >= profile.audition.k && candidates.every((c) => Number.isFinite(c.scores.total));
  return {
    outputs: { "material-map": mapSha, audition: auditionSha },
    usage: addUsage(sampled.usage, rubricUsage(rubric.results)),
    retries: sampled.retries,
    checks: [
      { name: "material-map", pass: true, detail: `${map.signals.length} signals, ${map.candidates.length} candidates` },
      { name: "audition-scored", gate: true, pass: scored, detail: `${candidates.length} candidates scored by code, k ${profile.audition.k}; pick ${record.pick.candidate}, margin ${record.margin}` },
    ],
    notes: [...mapSummary(map), ...auditionNotes(record)],
  };
}
