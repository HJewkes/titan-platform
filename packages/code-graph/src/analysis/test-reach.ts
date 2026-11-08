import type { GraphEdge, GraphNode } from "../types.js";

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
  return flowTests(callees, tests, () => true);
}

/** Flow the bits of the tests `seeded` accepts; the rest stay unset everywhere. */
function flowTests(
  callees: ReadonlyMap<string, readonly string[]>,
  tests: readonly string[],
  seeded: (test: number) => boolean,
): Map<string, Uint32Array> {
  const { ids, adj } = indexGraph(callees, tests);
  const { comp, components } = new Condensation(adj);
  const words = Math.ceil(tests.length / 32);
  const bits: (Uint32Array | undefined)[] = new Array(components.length);
  tests.forEach((_, i) => {
    if (!seeded(i)) return;
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

/**
 * Mocks one test file may declare before its masking is turned off (TP-4910). A file that replaces this
 * many modules is a harness standing in for its environment, and its walk runs on its own rather than in
 * the shared one-pass flow, so the cap also bounds how much a single file can cost.
 */
export const MOCK_MASK_CAP = 32;

export interface MockProfiles {
  /** Per test id, the node ids its `vi.mock` / `jest.mock` calls replace. */
  mocked: ReadonlyMap<string, readonly string[]>;
  /** Per node id, the callees it loads through `require()`, which a mock never masks. */
  requires?: ReadonlyMap<string, ReadonlySet<string>>;
  /** Defaults to {@link MOCK_MASK_CAP}. */
  cap?: number;
}

/** A test whose mocks were not masked, and why. */
export interface UnmaskedTest {
  testId: string;
  mocks: number;
  reason: string;
}

export interface MaskedReach {
  /** As {@link testsReaching} returns, with each test's mocked hops left out. */
  reaching: Map<string, Uint32Array>;
  unmasked: UnmaskedTest[];
}

/** Per test index, the mocked node ids to mask: only tests with at least one mock, within the cap. */
function maskPlan(tests: readonly string[], profiles: MockProfiles) {
  const cap = profiles.cap ?? MOCK_MASK_CAP;
  const masks = new Map<number, Set<string>>();
  const unmasked: UnmaskedTest[] = [];
  tests.forEach((testId, i) => {
    const mocked = new Set(profiles.mocked.get(testId) ?? []);
    if (mocked.size === 0) return;
    if (mocked.size <= cap) masks.set(i, mocked);
    else unmasked.push({ testId, mocks: mocked.size, reason: `${mocked.size} mocks exceed the cap of ${cap}; masking is off` });
  });
  return { masks, unmasked };
}

/** Every node `start` reaches without entering a `mocked` node through anything but a `require()`. */
function maskedClosure(
  callees: ReadonlyMap<string, readonly string[]>,
  start: string,
  mocked: ReadonlySet<string>,
  requires: MockProfiles["requires"],
): Set<string> {
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length > 0) {
    const from = queue.pop()!;
    for (const to of callees.get(from) ?? []) {
      if (seen.has(to) || (mocked.has(to) && !requires?.get(from)?.has(to))) continue;
      seen.add(to);
      queue.push(to);
    }
  }
  return seen;
}

/** Set test `i`'s bit on `id`, copying first a bitset the flow shares across a component. */
function setOwnBit(out: Map<string, Uint32Array>, owned: Set<string>, id: string, i: number, words: number): void {
  let b = out.get(id);
  if (!b || !owned.has(id)) {
    b = b ? b.slice() : new Uint32Array(words);
    out.set(id, b);
    owned.add(id);
  }
  b[i >>> 5]! |= 1 << (i & 31);
}

/**
 * {@link testsReaching} for tests that mock modules (TP-4910): a test does not reach a module through
 * a hop its own mock replaces, though another test's real import of it still counts, and a `require()`
 * hop stays live. Each masked test is walked on its own; a test over the cap flows unmasked and is
 * listed in `unmasked` with the reason.
 */
export function testsReachingMasked(
  callees: ReadonlyMap<string, readonly string[]>,
  tests: readonly string[],
  profiles: MockProfiles,
): MaskedReach {
  const { masks, unmasked } = maskPlan(tests, profiles);
  const reaching = flowTests(callees, tests, (i) => !masks.has(i));
  const words = Math.ceil(tests.length / 32);
  const owned = new Set<string>();
  for (const [i, mocked] of masks) {
    for (const id of maskedClosure(callees, tests[i]!, mocked, profiles.requires)) setOwnBit(reaching, owned, id, i, words);
  }
  return { reaching, unmasked };
}

function pushTo(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function addTo(map: Map<string, Set<string>>, key: string, value: string): void {
  const set = map.get(key);
  if (set) set.add(value);
  else map.set(key, new Set([value]));
}

/** The runtime module hops (type-only ones load nothing), the `require()` ones among them, and each file's `mocks` targets. */
function moduleHops(edges: readonly GraphEdge[]) {
  const callees = new Map<string, string[]>();
  const mocked = new Map<string, string[]>();
  const requires = new Map<string, Set<string>>();
  for (const e of edges) {
    if (e.kind === "mocks") pushTo(mocked, e.srcId, e.dstId);
    else if ((e.kind === "imports" || e.kind === "re-exports") && e.srcId !== e.dstId && !e.attrs?.typeOnly) {
      pushTo(callees, e.srcId, e.dstId);
      if (e.attrs?.require === true) addTo(requires, e.srcId, e.dstId);
    }
  }
  return { callees, mocked, requires };
}

/**
 * Which test files reach each file through runtime `imports` and `re-exports`, each test's `mocks`
 * masked as {@link testsReachingMasked} does (TP-4910). An `imports` edge marked `require` stays live
 * under a mock (TP-4950). `tests` lists the test file ids in bit order.
 */
export function fileTestReach(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  cap = MOCK_MASK_CAP,
): MaskedReach & { tests: string[] } {
  const tests = nodes.filter((n) => n.kind === "file" && n.role === "test").map((n) => n.id);
  const { callees, mocked, requires } = moduleHops(edges);
  return { tests, ...testsReachingMasked(callees, tests, { mocked, requires, cap }) };
}
