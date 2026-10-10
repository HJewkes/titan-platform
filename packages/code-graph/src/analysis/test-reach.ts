/**
 * Which tests reach each node of a call graph, in one pass (TP-2170). The graph is
 * condensed into strongly connected components (Tarjan, iterative so a deep call
 * chain cannot overflow the stack), and a bitset of tests flows from each component
 * to its callees in topological order. Every node of a component reaches every
 * other, so the component's bitset is each member's. Cost is linear in the edges
 * times the bitset width, rather than one closure per test.
 */
class Condensation {
  readonly comp: Int32Array;
  /** Components in Tarjan's completion order: every component after the ones it calls into. */
  readonly components: number[][] = [];
  private readonly index: Int32Array;
  private readonly low: Int32Array;
  private readonly onStack: Uint8Array;
  private readonly stack: number[] = [];
  private next = 0;

  constructor(private readonly adj: readonly number[][]) {
    const n = adj.length;
    this.comp = new Int32Array(n).fill(-1);
    this.index = new Int32Array(n).fill(-1);
    this.low = new Int32Array(n);
    this.onStack = new Uint8Array(n);
    for (let root = 0; root < n; root++) if (this.index[root] === -1) this.visit(root);
  }

  private visit(root: number): void {
    const work: [number, number][] = [[root, 0]];
    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      const [v, i] = frame;
      if (i === 0) this.open(v);
      if (i < this.adj[v]!.length) {
        frame[1]++;
        const w = this.adj[v]![i]!;
        if (this.index[w] === -1) work.push([w, 0]);
        else if (this.onStack[w]) this.low[v] = Math.min(this.low[v]!, this.index[w]!);
        continue;
      }
      work.pop();
      const parent = work[work.length - 1]?.[0];
      if (parent !== undefined) this.low[parent] = Math.min(this.low[parent]!, this.low[v]!);
      if (this.low[v] === this.index[v]) this.close(v);
    }
  }

  private open(v: number): void {
    this.index[v] = this.low[v] = this.next++;
    this.stack.push(v);
    this.onStack[v] = 1;
  }

  private close(v: number): void {
    const members: number[] = [];
    let w: number;
    do {
      w = this.stack.pop()!;
      this.onStack[w] = 0;
      this.comp[w] = this.components.length;
      members.push(w);
    } while (w !== v);
    this.components.push(members);
  }
}

function orInto(target: Uint32Array, source: Uint32Array): void {
  for (let i = 0; i < source.length; i++) target[i]! |= source[i]!;
}

/** Number the call graph's nodes, tests included, and build index adjacency. */
function indexGraph(callees: ReadonlyMap<string, readonly string[]>, tests: readonly string[]) {
  const ids = new Map<string, number>();
  const idOf = (id: string): number => ids.get(id) ?? (ids.set(id, ids.size), ids.size - 1);
  for (const t of tests) idOf(t);
  const pairs = [...callees].map(([src, dsts]) => [idOf(src), dsts.map(idOf)] as const);
  const adj: number[][] = Array.from({ length: ids.size }, () => []);
  for (const [src, dsts] of pairs) adj[src] = [...dsts];
  return { ids, adj };
}

/**
 * For each node any test reaches, a bitset over `tests` (bit i is `tests[i]`) of the tests that reach it
 * through `callees`, a test reaching itself. Nodes no test reaches are absent.
 */
export function testsReaching(
  callees: ReadonlyMap<string, readonly string[]>,
  tests: readonly string[],
): Map<string, Uint32Array> {
  const { ids, adj } = indexGraph(callees, tests);
  const { comp, components } = new Condensation(adj);
  const words = Math.ceil(tests.length / 32);
  const bits: (Uint32Array | undefined)[] = new Array(components.length);
  tests.forEach((_, i) => {
    const c = comp[i]!;
    (bits[c] ??= new Uint32Array(words))[i >>> 5]! |= 1 << (i & 31);
  });
  for (let c = components.length - 1; c >= 0; c--) {
    const own = bits[c];
    if (!own) continue;
    for (const v of components[c]!) {
      for (const w of adj[v]!) if (comp[w] !== c) orInto((bits[comp[w]!] ??= new Uint32Array(words)), own);
    }
  }
  const out = new Map<string, Uint32Array>();
  for (const [id, i] of ids) {
    const b = bits[comp[i]!];
    if (b) out.set(id, b);
  }
  return out;
}

/** Set bits of `a & b`. */
export function countShared(a: Uint32Array, b: Uint32Array): number {
  let count = 0;
  for (let i = 0; i < a.length; i++) {
    let x = a[i]! & b[i]!;
    while (x !== 0) {
      x &= x - 1;
      count++;
    }
  }
  return count;
}
