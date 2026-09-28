// FNV-1a keeps the package dependency-free and runtime-neutral (no node:crypto).
function hashSeed(seed: string | number): number {
  let h = 0x811c9dc5;
  for (const ch of String(seed)) {
    h ^= ch.codePointAt(0) as number;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** A deterministic generator of floats in [0, 1) from a string or number seed (mulberry32). */
export function seededRandom(seed: string | number): () => number {
  let state = hashSeed(seed);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomInt(random: () => number, below: number): number {
  return Math.floor(random() * below);
}
