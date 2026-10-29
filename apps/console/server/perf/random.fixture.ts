import { seededRandom } from "@titan-design/evidence";

/** Every fixture clock reads from here, so two builds with one seed write the same bytes whatever day they run. */
export const FIXTURE_EPOCH_MS = Date.parse("2031-01-01T00:00:00.000Z");
const HOUR_MS = 3_600_000;

export interface Draw {
  /** An integer in [0, below). */
  int(below: number): number;
  chance(probability: number): boolean;
  pick<T>(choices: readonly T[]): T;
  /** Up to `most` distinct picks, in the order drawn. */
  some<T>(choices: readonly T[], most: number): T[];
}

export function draw(seed: string): Draw {
  const next = seededRandom(seed);
  const int = (below: number): number => Math.floor(next() * below);
  const pick = <T>(choices: readonly T[]): T => choices[int(choices.length)]!;
  const some = <T>(choices: readonly T[], most: number): T[] => [...new Set(Array.from({ length: int(most + 1) }, () => pick(choices)))];
  return { int, chance: (probability) => next() < probability, pick, some };
}

/** `hours` after the fixture epoch, as an ISO timestamp. */
export const isoAt = (hours: number): string => new Date(FIXTURE_EPOCH_MS + hours * HOUR_MS).toISOString();

export const dateAt = (hours: number): Date => new Date(FIXTURE_EPOCH_MS + hours * HOUR_MS);

export const pad = (value: number, width = 4): string => String(value).padStart(width, "0");

export const WORDS = ["amber", "basalt", "cinder", "delta", "ember", "fjord", "garnet", "harbor", "indigo", "juniper", "kestrel", "lumen", "meadow", "nectar", "onyx", "pylon", "quartz", "ridge", "sable", "tundra"] as const;
