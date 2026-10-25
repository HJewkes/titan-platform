import { z } from "zod";
import { BEAT_SLOTS } from "../beat-slots.js";
import { withSlotOverrides } from "../slot-overrides.js";
import type { ScriptBeat } from "../script-schema.js";
import { freezeSim } from "./freeze.js";
import { SIM_MODELS, type SimModel } from "./model.js";
import { SIM_CHECK_CODES, numberFacts, simCheck, simFailure, sweepValues, type SimBeat, type SimVerdict } from "./sim-check.js";
import { defaultsOf, loadSims, simDoctrineSha, type SimModelSpec } from "./sim-load.js";
import { sweepSim } from "./sweep.js";

/** The code models and their doctrine files the resolve stage sweeps sim beats with. */
export interface SimRegistry {
  models: Readonly<Record<string, SimModel>>;
  specs: ReadonlyMap<string, SimModelSpec>;
}

export const shippedSims = (): SimRegistry => ({ models: SIM_MODELS, specs: loadSims() });

export const SIM_BEAT = "sim";

const SimVerdictSchema = z.object({
  beat: z.string(),
  pass: z.boolean(),
  claim: z.number().optional(),
  got: z.number().optional(),
  se: z.number().optional(),
  tolerance: z.number().optional(),
  code: z.enum(SIM_CHECK_CODES).optional(),
  detail: z.string(),
});

/** The `sim-traces` artifact: each swept beat's frozen trace by store sha, and every sim beat's verdict. */
export const SimTracesSchema = z.object({
  schema: z.literal("explainer.sim-traces/v1"),
  traces: z.record(z.string(), z.string()),
  verdicts: z.array(SimVerdictSchema),
});
export type SimTraces = z.infer<typeof SimTracesSchema>;

/** What the sim pass reads of a run: the sim beats, the template fill's slots, the gathered facts and the registry. */
export interface SimPassInput {
  beats: readonly Pick<ScriptBeat, "id" | "spoken" | "visual">[];
  slots: Readonly<Record<string, unknown>> | undefined;
  facts: string | undefined;
  registry: SimRegistry;
  /** Stores one frozen trace's canonical JSON and returns its sha. */
  putTrace: (json: string) => string;
}

export interface SimPass {
  traces: SimTraces;
  /** Sim beats with no sim slots yet: nothing to sweep. */
  unslotted: string[];
}

function sweepBeat(beat: SimBeat, facts: ReadonlyMap<string, number>, input: SimPassInput): { verdict: SimVerdict; sha?: string } {
  const { model: id, seed, params, sweep } = beat.slots;
  const model = Object.hasOwn(input.registry.models, id) ? input.registry.models[id] : undefined;
  const spec = input.registry.specs.get(id);
  if (!model || !spec) return { verdict: simFailure(beat.id, "E-SIM-NO-RUN", `sim model ${id} is not in both SIM_MODELS and doctrine/sims`) };
  try {
    const swept = sweepSim(model, { ...defaultsOf(spec), ...params }, { param: sweep.param, values: sweepValues(sweep) }, seed);
    const frozen = freezeSim(swept, simDoctrineSha(spec));
    return { verdict: simCheck(frozen.trace, beat, facts, spec), sha: input.putTrace(frozen.json) };
  } catch (error) {
    return { verdict: simFailure(beat.id, "E-SIM-NO-RUN", `sim ${id} did not run: ${error instanceof Error ? error.message : String(error)}`) };
  }
}

/**
 * Sweeps, freezes and checks each sim beat. Its slots are the template fill's with the owner's overrides laid over
 * them; a beat with no parseable sim slots yet is listed, not swept.
 */
export function runSimPass(input: SimPassInput): SimPass {
  const facts = numberFacts(input.facts);
  const out: SimPass = { traces: { schema: "explainer.sim-traces/v1", traces: {}, verdicts: [] }, unslotted: [] };
  for (const { id, spoken, visual } of input.beats) {
    const slots = BEAT_SLOTS.sim.safeParse(withSlotOverrides(visual, input.slots?.[id]));
    if (!slots.success) {
      out.unslotted.push(id);
      continue;
    }
    const { verdict, sha } = sweepBeat({ id, spoken, slots: slots.data }, facts, input);
    out.traces.verdicts.push(verdict);
    if (sha !== undefined) out.traces.traces[id] = sha;
  }
  return out;
}
