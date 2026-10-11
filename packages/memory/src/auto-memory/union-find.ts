/** Single-link clustering of `items` under `linked`; each cluster keeps the input order of its members. */
export function linkClusters<T>(items: readonly T[], linked: (a: T, b: T) => boolean): T[][] {
  const parent = items.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root] ?? root;
    parent[index] = root;
    return root;
  };
  items.forEach((a, i) => {
    items.forEach((b, j) => {
      if (j > i && find(i) !== find(j) && linked(a, b)) parent[find(j)] = find(i);
    });
  });
  const clusters = new Map<number, T[]>();
  items.forEach((item, index) => {
    const root = find(index);
    clusters.set(root, [...(clusters.get(root) ?? []), item]);
  });
  return [...clusters.values()];
}
