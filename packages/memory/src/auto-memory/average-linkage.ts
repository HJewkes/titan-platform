export interface LinkageOptions {
  /** Average pairwise similarity at or above which two clusters may merge. */
  threshold: number;
  /** No merge may produce a cluster larger than this. */
  maxSize: number;
}

type Pair = readonly [number, number];

function similarityMatrix(count: number, similarity: (i: number, j: number) => number): number[][] {
  const matrix = Array.from({ length: count }, () => new Array<number>(count).fill(0));
  for (let i = 0; i < count; i++) {
    for (let j = i + 1; j < count; j++) {
      const value = similarity(i, j);
      (matrix[i] as number[])[j] = value;
      (matrix[j] as number[])[i] = value;
    }
  }
  return matrix;
}

// Strictly greater, scanning i then j, so ties go to the lowest pair in input order.
function bestPair(matrix: readonly number[][], clusters: readonly (number[] | null)[], options: LinkageOptions): Pair | null {
  let best: Pair | null = null;
  let bestValue = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < clusters.length; i++) {
    for (let j = i + 1; j < clusters.length; j++) {
      const [a, b] = [clusters[i], clusters[j]];
      if (!a || !b || a.length + b.length > options.maxSize) continue;
      const value = matrix[i]?.[j] ?? Number.NEGATIVE_INFINITY;
      if (value >= options.threshold && value > bestValue) [best, bestValue] = [[i, j], value];
    }
  }
  return best;
}

// The UPGMA Lance-Williams update: the merged cluster's similarity to k is the size-weighted mean.
function merge(matrix: number[][], clusters: (number[] | null)[], [i, j]: Pair): void {
  const [a, b] = [clusters[i] ?? [], clusters[j] ?? []];
  const rowI = matrix[i] as number[];
  const rowJ = matrix[j] as number[];
  clusters.forEach((other, k) => {
    if (!other || k === i || k === j) return;
    const value = (a.length * (rowI[k] ?? 0) + b.length * (rowJ[k] ?? 0)) / (a.length + b.length);
    rowI[k] = value;
    (matrix[k] as number[])[i] = value;
  });
  clusters[i] = [...a, ...b].sort((x, y) => x - y);
  clusters[j] = null;
}

/**
 * Average-linkage (UPGMA) clustering of `items`, where `similarity(i, j)` scores two item indexes. Merging
 * stops when no pair of clusters within `maxSize` averages `threshold` or more. Clusters keep the input
 * order of their members and come out ordered by their first member.
 */
export function averageLinkage<T>(items: readonly T[], similarity: (i: number, j: number) => number, options: LinkageOptions): T[][] {
  const matrix = similarityMatrix(items.length, similarity);
  const clusters: (number[] | null)[] = items.map((_, index) => [index]);
  for (let pair = bestPair(matrix, clusters, options); pair; pair = bestPair(matrix, clusters, options)) merge(matrix, clusters, pair);
  return clusters.filter((members): members is number[] => members !== null).map((members) => members.map((index) => items[index] as T));
}
