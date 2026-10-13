interface LinkageOptions {
  /** Average pairwise similarity at or above which two clusters may merge. */
  threshold: number;
  /** No merge may produce a cluster larger than this. */
  maxSize: number;
}

interface Member<T> {
  index: number;
  item: T;
}

type Pair = readonly [number, number];

/** A symmetric similarity matrix stored flat, row-major. */
class Matrix {
  private readonly cells: Float64Array;

  constructor(readonly size: number) {
    this.cells = new Float64Array(size * size);
  }

  get(i: number, j: number): number {
    return this.cells[i * this.size + j] ?? 0;
  }

  set(i: number, j: number, value: number): void {
    this.cells[i * this.size + j] = value;
    this.cells[j * this.size + i] = value;
  }
}

function similarityMatrix(count: number, similarity: (i: number, j: number) => number): Matrix {
  const matrix = new Matrix(count);
  for (let i = 0; i < count; i++) for (let j = i + 1; j < count; j++) matrix.set(i, j, similarity(i, j));
  return matrix;
}

// Strictly greater, scanning i then j, so ties go to the lowest pair in input order.
function bestPair<T>(matrix: Matrix, clusters: readonly (Member<T>[] | null)[], options: LinkageOptions): Pair | null {
  let best: Pair | null = null;
  let bestValue = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < clusters.length; i++) {
    for (let j = i + 1; j < clusters.length; j++) {
      const [a, b] = [clusters[i], clusters[j]];
      if (!a || !b || a.length + b.length > options.maxSize) continue;
      const value = matrix.get(i, j);
      if (value >= options.threshold && value > bestValue) [best, bestValue] = [[i, j], value];
    }
  }
  return best;
}

// The UPGMA Lance-Williams update: the merged cluster's similarity to k is the size-weighted mean.
function merge<T>(matrix: Matrix, clusters: (Member<T>[] | null)[], [i, j]: Pair): void {
  const [a, b] = [clusters[i] ?? [], clusters[j] ?? []];
  clusters.forEach((other, k) => {
    if (!other || k === i || k === j) return;
    matrix.set(i, k, (a.length * matrix.get(i, k) + b.length * matrix.get(j, k)) / (a.length + b.length));
  });
  clusters[i] = [...a, ...b].sort((x, y) => x.index - y.index);
  clusters[j] = null;
}

/**
 * Average-linkage (UPGMA) clustering of `items`, where `similarity(i, j)` scores two item indexes. Merging
 * stops when no pair of clusters within `maxSize` averages `threshold` or more. Clusters keep the input
 * order of their members and come out ordered by their first member.
 */
export function averageLinkage<T>(items: readonly T[], similarity: (i: number, j: number) => number, options: LinkageOptions): T[][] {
  const matrix = similarityMatrix(items.length, similarity);
  const clusters: (Member<T>[] | null)[] = items.map((item, index) => [{ index, item }]);
  for (let pair = bestPair(matrix, clusters, options); pair; pair = bestPair(matrix, clusters, options)) merge(matrix, clusters, pair);
  return clusters.filter((members) => members !== null).map((members) => members.map(({ item }) => item));
}
