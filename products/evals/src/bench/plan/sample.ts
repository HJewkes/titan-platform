import { briefLeaks, drawOrder, type PlanCase } from "./cases.js";

/**
 * Smooth weighted round robin: each step takes the list furthest behind its share, so every prefix of the result
 * holds each list in close to its weight (12:8 puts 6 and 4 in the first 10).
 */
function interleave<T>(lists: readonly (readonly T[])[]): T[] {
  const total = lists.reduce((sum, list) => sum + list.length, 0);
  const taken = lists.map(() => 0);
  const out: T[] = [];
  for (let step = 0; step < total; step++) {
    let best = -1;
    let bestLag = -Infinity;
    lists.forEach((list, index) => {
      const lag = (list.length * (step + 1)) / total - (taken[index] ?? 0);
      if ((taken[index] ?? 0) < list.length && lag > bestLag) [best, bestLag] = [index, lag];
    });
    const next = lists[best]?.[taken[best] ?? 0];
    if (next === undefined) break;
    out.push(next);
    taken[best] = (taken[best] ?? 0) + 1;
  }
  return out;
}

/** Largest-remainder shares of n over the strata; a tied remainder goes to the larger stratum, then the first name. */
function allocate(sizes: ReadonlyMap<string, number>, n: number): Map<string, number> {
  const total = [...sizes.values()].reduce((sum, size) => sum + size, 0);
  const wanted = Math.min(n, total);
  const exact = [...sizes].map(([name, size]) => ({ name, share: total === 0 ? 0 : (size * wanted) / total }));
  const counts = new Map(exact.map(({ name, share }) => [name, Math.floor(share)]));
  let left = wanted - [...counts.values()].reduce((sum, count) => sum + count, 0);
  for (const { name } of [...exact].sort((a, b) => (b.share % 1) - (a.share % 1) || b.share - a.share || a.name.localeCompare(b.name))) {
    if (left <= 0) break;
    counts.set(name, (counts.get(name) ?? 0) + 1);
    left--;
  }
  return counts;
}

interface Drawn {
  picked: PlanCase[];
  rejected: PlanCase[];
}

/** Walks the stratum in draw order; a leaking brief is set aside and the next case takes its place. */
function drawStratum(cases: readonly PlanCase[], n: number, seed: string): Drawn {
  const picked: PlanCase[] = [];
  const rejected: PlanCase[] = [];
  for (const candidate of drawOrder(seed, cases)) {
    if (picked.length >= n) break;
    (briefLeaks(candidate) ? rejected : picked).push(candidate);
  }
  return { picked, rejected };
}

function byKind(cases: readonly PlanCase[]): Map<string, PlanCase[]> {
  const groups = new Map<string, PlanCase[]>();
  for (const planCase of [...cases].sort((a, b) => a.kind.localeCompare(b.kind))) groups.set(planCase.kind, [...(groups.get(planCase.kind) ?? []), planCase]);
  return groups;
}

/** One pool stratified by kind: shares by stratum size, then the strata interleaved by those shares. */
function samplePool(cases: readonly PlanCase[], n: number, seed: string): Drawn {
  const groups = byKind(cases);
  const counts = allocate(new Map([...groups].map(([kind, list]) => [kind, list.length])), n);
  const drawn = [...groups].map(([kind, list]) => drawStratum(list, counts.get(kind) ?? 0, seed));
  return { picked: interleave(drawn.map(({ picked }) => picked)), rejected: drawn.flatMap(({ rejected }) => rejected) };
}

interface PlanSample {
  queue: PlanCase[];
  rejected: PlanCase[];
}

/** The run's case queue: each pool sampled by kind, then the pools interleaved so any prefix is a balanced sample. */
export function samplePlanCases(pools: { multi: readonly PlanCase[]; single: readonly PlanCase[] }, counts: { multi: number; single: number }, seed: string): PlanSample {
  const multi = samplePool(pools.multi, counts.multi, seed);
  const single = samplePool(pools.single, counts.single, seed);
  return { queue: interleave([multi.picked, single.picked]), rejected: [...multi.rejected, ...single.rejected] };
}
