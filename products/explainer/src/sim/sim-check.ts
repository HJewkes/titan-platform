import { z } from "zod";
import type { BEAT_SLOTS } from "../beat-slots.js";
import { claimText } from "../lint-claims.js";
import { hasSpokenDigits } from "../spoken-numbers.js";
import type { SimModelSpec, SimTolerance } from "./sim-load.js";
import type { SimTrace, Stat } from "./trace-schema.js";

/** A tolerance looser than this share of the claim is refused: loosening it is a reviewed code change, not a doctrine edit. */
export const MAX_SIM_TOLERANCE_REL = 0.1;

/** A tolerance must be at least this many standard errors wide, or Monte Carlo noise alone could flip the verdict. */
export const SIM_NOISE_SE = 3;

export const SIM_CHECK_CODES = ["E-SIM-MISS", "E-SIM-NO-FACT", "E-SIM-NO-RUN", "E-SIM-TOL-NOISE", "E-SIM-TOL-LOOSE", "E-SIM-CIRCULAR", "E-SIM-UNCHECKED-NUMBER", "E-SIM-NO-SLOTS"] as const;
export type SimCheckCode = (typeof SIM_CHECK_CODES)[number];

export type SimSlots = z.infer<(typeof BEAT_SLOTS)["sim"]>;

/** A sim beat's verdict. `tolerance` is the absolute allowance the doctrine tolerance gives at this claim. */
export interface SimVerdict {
  beat: string;
  pass: boolean;
  claim?: number;
  got?: number;
  se?: number;
  tolerance?: number;
  code?: SimCheckCode;
  detail: string;
}

/** What sim-check reads of a beat: its id, its narration and its sim slots. */
export interface SimBeat {
  id: string;
  spoken: string;
  slots: SimSlots;
}

export const simFailure = (beat: string, code: SimCheckCode, detail: string, measured: Partial<SimVerdict> = {}): SimVerdict => ({ beat, pass: false, ...measured, code, detail });

const NumberFactSchema = z.object({ id: z.string().min(1), kind: z.literal("number"), value: z.number().finite() });

const parsedLine = (line: string): unknown => {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
};

/** The gathered `number` facts by id, from a JSON-lines facts pack; any other line holds no claim value. */
export function numberFacts(text: string | undefined): Map<string, number> {
  const facts = new Map<string, number>();
  for (const line of (text ?? "").split("\n").filter((row) => row.trimStart().startsWith("{"))) {
    const fact = NumberFactSchema.safeParse(parsedLine(line));
    if (fact.success) facts.set(fact.data.id, fact.data.value);
  }
  return facts;
}

/** The swept values a slot's `sweep` names, evenly spaced from `from` to `to`, trimmed of float noise. */
export const sweepValues = ({ from, to, steps }: SimSlots["sweep"]): number[] =>
  Array.from({ length: steps }, (_, i) => Number((from + (i * (to - from)) / (steps - 1)).toPrecision(12)));

const sameValue = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

function statAt(trace: SimTrace, at: number, statistic: string): Stat | undefined {
  const run = trace.runs.find((candidate) => sameValue(candidate.at[trace.sweep.param] ?? Number.NaN, at));
  return run && Object.hasOwn(run.stats, statistic) ? run.stats[statistic] : undefined;
}

const looseness = (tolerance: SimTolerance, claim: number): number => ("rel" in tolerance ? tolerance.rel : tolerance.abs / Math.abs(claim));

/** An illustrative sim (no claim) is not checked, so its narration may state no number the check never saw. */
function uncheckedVerdict(beat: SimBeat): SimVerdict {
  if (hasSpokenDigits(claimText(beat.spoken))) return simFailure(beat.id, "E-SIM-UNCHECKED-NUMBER", `beat ${beat.id} names no claim, but its narration states a number`);
  return { beat: beat.id, pass: true, detail: `beat ${beat.id} is illustrative: swept and frozen, not checked` };
}

function toleranceVerdict(beat: string, tolerance: SimTolerance, measured: Required<Pick<SimVerdict, "claim" | "got" | "se" | "tolerance">>): SimVerdict {
  const { claim, got, se, tolerance: allowed } = measured;
  const loose = `tolerance ±${allowed} is looser than ${MAX_SIM_TOLERANCE_REL * 100}% of the claim ${claim}`;
  if (looseness(tolerance, claim) > MAX_SIM_TOLERANCE_REL) return simFailure(beat, "E-SIM-TOL-LOOSE", loose, measured);
  if (allowed < SIM_NOISE_SE * se) return simFailure(beat, "E-SIM-TOL-NOISE", `tolerance ±${allowed} is under ${SIM_NOISE_SE}·se (se ${se}): noise alone could flip it`, measured);
  if (Math.abs(got - claim) > allowed) return simFailure(beat, "E-SIM-MISS", `the sim gives ${got}, outside ${claim} ±${allowed}`, measured);
  return { beat, pass: true, ...measured, detail: `the sim gives ${got}, within ${claim} ±${allowed}` };
}

/**
 * Whether a sim beat's trace reproduces its claim: the claim's value is a gathered number fact, its tolerance is the
 * doctrine's, and code holds that tolerance between the noise floor and the looseness ceiling. A statistic the
 * doctrine fitted a parameter to proves nothing, so a claim on it fails. Pure.
 */
export function simCheck(trace: SimTrace, beat: SimBeat, facts: ReadonlyMap<string, number>, doctrine: SimModelSpec): SimVerdict {
  const { claim } = beat.slots;
  if (!claim) return uncheckedVerdict(beat);
  if (doctrine.fittedFrom.includes(claim.statistic)) return simFailure(beat.id, "E-SIM-CIRCULAR", `statistic ${claim.statistic} calibrated the model (fittedFrom), so reproducing it proves nothing`);
  const value = facts.get(claim.fact);
  if (value === undefined) return simFailure(beat.id, "E-SIM-NO-FACT", `fact ${claim.fact} is not a gathered number fact`);
  const stat = statAt(trace, claim.at, claim.statistic);
  const declared = Object.hasOwn(doctrine.statistics, claim.statistic) ? doctrine.statistics[claim.statistic] : undefined;
  if (!stat || !declared) return simFailure(beat.id, "E-SIM-NO-RUN", `no run at ${trace.sweep.param}=${claim.at} emits doctrine statistic ${claim.statistic}`, { claim: value });
  const { tolerance } = declared;
  const allowed = "abs" in tolerance ? tolerance.abs : tolerance.rel * Math.abs(value);
  return toleranceVerdict(beat.id, tolerance, { claim: value, got: stat.value, se: stat.se, tolerance: allowed });
}
