import type { ArRegistries, ArRunView } from "../../server/autoresearch-view.js";

/** The factory's `REGISTRY_TAIL`: the rows every implementer brief and planner digest carries. */
export const REGISTRY_TAIL = 40;

export function registryTails(registries: ArRegistries): ArRegistries {
  return { deadEnds: registries.deadEnds.slice(-REGISTRY_TAIL), bugs: registries.bugs.slice(-REGISTRY_TAIL) };
}

export interface RoundRepeats {
  round: number;
  failures: number;
  repeats: number;
  /** Undefined when the round had no L0 failure, so a quiet round does not read as a 0% repeat rate. */
  rate: number | undefined;
}

/** The factory records a non-kept outcome that stopped at L0 as a bug whose symptom is its reason code. */
const l0Failures = (round: ArRunView["rounds"][number]): string[] =>
  round.ladders.flatMap(({ outcome }) => (outcome !== null && outcome.rungReached === "L0" && outcome.verdict !== "kept" ? [outcome.reason] : []));

/**
 * Design §1.6 and §4.3: per round, the share of L0 failures whose reason code an earlier round had already put in the bug
 * registry. Replayed from the rounds rather than read off the registry, whose rows carry no round.
 */
export function bugRepeatRates(run: ArRunView): RoundRepeats[] {
  const seen = new Set<string>();
  return run.rounds.map((round) => {
    const codes = l0Failures(round);
    const repeats = codes.filter((code) => seen.has(code)).length;
    codes.forEach((code) => seen.add(code));
    return { round: round.round, failures: codes.length, repeats, rate: codes.length === 0 ? undefined : repeats / codes.length };
  });
}
