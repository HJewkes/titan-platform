import { choppy } from "./rewrite-fixtures.test-helpers.js";
import { visual } from "./resolve-fixtures.test-helpers.js";
import { resolveConfig, ResolvedSchema, runResolveStage } from "./resolve-stage.js";
import { RESOLVE_ROWS } from "./resolve-tables.js";
import { fixedGeometric, toySpec } from "./sim/sim-fixtures.test-helpers.js";
import type { SimTolerance } from "./sim/sim-load.js";
import type { SimRegistry } from "./sim/sim-resolve.js";
import { sha256 } from "./workflow/artifacts.js";
import { runStageChecks } from "./workflow/stage-checks.js";

// Synthetic: the parcel-desk script with toy sims; fixed-geometric gives exactly 1 / p tries, so p = 0.25 gives 4.
const json = (value: unknown): string => JSON.stringify(value);

export function registry(tolerance: SimTolerance = { abs: 0.25 }): SimRegistry {
  const spec = { ...toySpec("toy"), statistics: { "mean-tries": { tolerance, why: "Synthetic tolerance." } } };
  return { models: { toy: { ...fixedGeometric, id: "toy" } }, specs: new Map([["toy", spec]]) };
}

const simSlots = (fact: string) => ({
  model: "toy",
  seed: 7,
  params: {},
  sweep: { param: "p", from: 0.25, to: 0.5, steps: 2 },
  claim: { fact, statistic: "mean-tries", at: 0.25 },
  readouts: [{ id: "mean", label: "Mean tries" }],
});

const FACTS = [
  { id: "F-near", kind: "number", text: "A synthetic mean of 4.1 tries.", value: 4.1 },
  { id: "F-far", kind: "number", text: "A synthetic mean of 6 tries.", value: 6 },
].map(json).join("\n");

interface StageOptions {
  sims?: SimRegistry;
  /** Where each sim beat's slots come from: the `slots` pin, or the script's own `visual.slots` override. */
  via?: "pin" | "visual";
  /** Fields laid over every sim beat's visual, such as emphasis cues. */
  patch?: Record<string, unknown>;
}

/** The resolve stage over an in-memory store, with the named beats of the fixture script made sim beats claiming `facts`. */
export function stage(claims: Record<string, string>, { sims = registry(), via = "pin", patch = {} }: StageOptions = {}) {
  const overrides = (fact: string) => (via === "visual" ? { slots: simSlots(fact) } : {});
  const extra = Object.fromEntries(Object.entries(claims).map(([id, fact]) => [id, { visual: visual({ beat: "sim", ...overrides(fact), ...patch }) }]));
  const slots = via === "pin" ? Object.fromEntries(Object.entries(claims).map(([id, fact]) => [id, simSlots(fact)])) : {};
  const texts = { script: json(choppy(extra)), slots: json(slots), facts: FACTS };
  const bySha = new Map(Object.values(texts).map((text) => [sha256(text), text]));
  const store = { readText: (sha: string) => bySha.get(sha)!, putText: (text: string) => (bySha.set(sha256(text), text), sha256(text)) };
  const inputs = Object.fromEntries(Object.entries(texts).map(([name, text]) => [name, sha256(text)]));
  const outcome = runResolveStage({ artifacts: inputs, store, from: { runId: "r", stage: "resolve" }, remainingUsd: 1 }, resolveConfig(RESOLVE_ROWS, sims.specs), sims);
  const artifacts = { ...inputs, ...outcome.outputs };
  const resolved = ResolvedSchema.parse(JSON.parse(store.readText(artifacts.resolved!)));
  const checks = runStageChecks("resolve", { artifacts, store, l0Checks: [] }).checks;
  return { outcome, store, resolved, checks, artifacts };
}
