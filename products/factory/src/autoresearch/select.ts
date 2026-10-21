import { createHash } from "node:crypto";
import type { Idea, Outcome } from "./schemas.js";

interface Arm {
  alpha: number;
  beta: number;
}

interface Draw {
  id: string;
  draw: number;
}

interface Selection {
  picks: Idea[];
  draws: Draw[];
  /** The planner's own top K by priority, logged beside the pick to test whether sampling earns its keep. */
  plannerTopK: string[];
}

/** Reward per finished idea; rule-file data once the config section lands. */
const REWARDS = { kept: 1, confirmLost: 0.6, L3: 0.3, L2: 0.1 } as const;

export function reward(outcome: Outcome): number {
  if (outcome.verdict === "kept") return REWARDS.kept;
  if (outcome.reason === "confirm-lost") return REWARDS.confirmLost;
  if (outcome.rungReached === "L3") return REWARDS.L3;
  if (outcome.rungReached === "L2") return REWARDS.L2;
  return 0;
}

function posteriors(outcomes: readonly Outcome[], by: (outcome: Outcome) => string): Map<string, Arm> {
  const arms = new Map<string, Arm>();
  for (const outcome of outcomes) {
    const arm = arms.get(by(outcome)) ?? { alpha: 1, beta: 1 };
    const r = reward(outcome);
    arms.set(by(outcome), { alpha: arm.alpha + r, beta: arm.beta + 1 - r });
  }
  return arms;
}

/** mulberry32: small, fast, and the same sequence for the same seed on every host. */
export function seededRandom(seed: string): () => number {
  let state = createHash("sha256").update(seed).digest().readUInt32LE(0);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normal(random: () => number): number {
  const u = 1 - random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
}

/** Marsaglia-Tsang; shapes below 1 are boosted by one and scaled back. */
function gamma(shape: number, random: () => number): number {
  if (shape < 1) return gamma(shape + 1, random) * random() ** (1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    const x = normal(random);
    const v = (1 + c * x) ** 3;
    if (v > 0 && Math.log(1 - random()) < 0.5 * x * x + d - d * v + d * Math.log(v)) return d * v;
  }
}

export function betaDraw(arm: Arm, random: () => number): number {
  const x = gamma(arm.alpha, random);
  return x / (x + gamma(arm.beta, random));
}

/** A lineage with history draws from its own posterior; a new one from its cell's, blended with Beta(1,1). */
function armFor(idea: Idea, lineages: Map<string, Arm>, cells: Map<string, Arm>): Arm {
  const own = lineages.get(idea.lineage);
  if (own) return own;
  const cell = cells.get(idea.cell) ?? { alpha: 1, beta: 1 };
  return { alpha: (cell.alpha + 1) / 2, beta: (cell.beta + 1) / 2 };
}

const byPriority = (a: Idea, b: Idea) => b.priority - a.priority || a.id.localeCompare(b.id);

/** Thompson sampling over lineages; the seed is `runId:round`, so a replayed round picks the same ideas. */
export function select(queue: readonly Idea[], outcomes: readonly Outcome[], options: { runId: string; round: number; k: number }): Selection {
  const random = seededRandom(`${options.runId}:${options.round}`);
  const lineages = posteriors(outcomes, (outcome) => outcome.lineage);
  const cells = posteriors(outcomes, (outcome) => outcome.cell);
  const ordered = [...queue].sort((a, b) => a.id.localeCompare(b.id));
  const draws = ordered.map((idea) => ({ idea, draw: betaDraw(armFor(idea, lineages, cells), random) }));
  draws.sort((a, b) => b.draw - a.draw || byPriority(a.idea, b.idea));
  return {
    picks: draws.slice(0, options.k).map(({ idea }) => idea),
    draws: draws.map(({ idea, draw }) => ({ id: idea.id, draw })),
    plannerTopK: [...queue].sort(byPriority).slice(0, options.k).map((idea) => idea.id),
  };
}
