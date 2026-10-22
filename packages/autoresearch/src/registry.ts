import type { Idea, Outcome } from "./schemas.js";

export const REGISTRY_TAIL = 40;

/** A cell, targets and direction that already failed past L0, so a repeat must say how it differs. */
export interface DeadEnd {
  ideaId: string;
  round: number;
  cell: string;
  targets: string[];
  rungFailed: string;
  deltaOverSigma?: number;
  lesson?: string;
}

/** "Fails here, do this instead", from L0 failures and planner analysis. */
interface Bug {
  /** Absent on a planner's analysis line, which names no single idea. */
  ideaId?: string;
  round: number;
  symptom: string;
  fix: string;
  source: "L0" | "planner";
}

export interface Registries {
  deadEnds: DeadEnd[];
  bugs: Bug[];
}

export const EMPTY_REGISTRIES: Registries = { deadEnds: [], bugs: [] };

const sameTargets = (a: readonly string[], b: readonly string[]) => [...a].sort().join("\n") === [...b].sort().join("\n");

export function inDeadEnd(idea: Pick<Idea, "cell" | "targets">, deadEnds: readonly DeadEnd[]): boolean {
  return deadEnds.some((entry) => entry.cell === idea.cell && sameTargets(entry.targets, idea.targets));
}

function deadEndOf(idea: Idea, outcome: Outcome, round: number): DeadEnd | undefined {
  const pastL0 = outcome.rungReached === "L1" || outcome.rungReached === "L2" || outcome.rungReached === "L3";
  if (outcome.verdict === "kept" || !pastL0) return undefined;
  const deltaOverSigma = outcome.delta !== undefined && outcome.sigma ? outcome.delta / outcome.sigma : undefined;
  return { ideaId: idea.id, round, cell: idea.cell, targets: idea.targets, rungFailed: outcome.rungReached, deltaOverSigma, lesson: outcome.lesson };
}

function bugOf(outcome: Outcome, round: number): Bug | undefined {
  if (outcome.rungReached !== "L0" || outcome.verdict === "kept") return undefined;
  return { ideaId: outcome.ideaId, round, symptom: outcome.reason, fix: outcome.lesson ?? "", source: "L0" };
}

export function recordOutcome(registries: Registries, idea: Idea, outcome: Outcome, round: number): Registries {
  const deadEnd = deadEndOf(idea, outcome, round);
  const bug = bugOf(outcome, round);
  return {
    deadEnds: deadEnd ? [...registries.deadEnds, deadEnd] : registries.deadEnds,
    bugs: bug ? [...registries.bugs, bug] : registries.bugs,
  };
}

export function recordAnalysis(registries: Registries, analysis: readonly string[], round: number): Registries {
  return { ...registries, bugs: [...registries.bugs, ...analysis.map((line) => ({ round, symptom: line, fix: "", source: "planner" as const }))] };
}

/** The tails every implementer brief and planner digest carry, capped so the brief stays bounded. */
export function registryTails(registries: Registries): Registries {
  return { deadEnds: registries.deadEnds.slice(-REGISTRY_TAIL), bugs: registries.bugs.slice(-REGISTRY_TAIL) };
}
