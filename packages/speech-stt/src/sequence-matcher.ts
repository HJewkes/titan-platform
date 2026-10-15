/**
 * A port of CPython's `difflib.SequenceMatcher` without `isjunk`. Callers that port Python
 * scoring code depend on its exact blocks and tie-breaking, not just on any longest match.
 */

/** `a[a..a+size]` equals `b[b..b+size]`. The last block is always `{a: len(a), b: len(b), size: 0}`. */
export interface Block {
  a: number;
  b: number;
  size: number;
}

export type OpcodeTag = "replace" | "delete" | "insert" | "equal";

/** Turns `a[i1..i2]` into `b[j1..j2]`, as CPython's `get_opcodes` tuples. */
export type Opcode = [tag: OpcodeTag, i1: number, i2: number, j1: number, j2: number];

export interface SequenceMatcherOptions {
  /** CPython's default: when `b` has 200 or more items, items filling over 1% of it are ignored as anchors. */
  autojunk?: boolean;
}

type Range = [alo: number, ahi: number, blo: number, bhi: number];

const AUTOJUNK_MIN_LENGTH = 200;

/** Items compare with `===` (Map key identity), as Python's `==` does for strings and numbers. */
export class SequenceMatcher<T> {
  private readonly a: readonly T[];
  private readonly b: readonly T[];
  private readonly b2j: Map<T, number[]>;
  private blocks: Block[] | undefined;

  /** Strings iterate by code point, as Python strings do. */
  constructor(a: Iterable<T>, b: Iterable<T>, opts: SequenceMatcherOptions = {}) {
    this.a = Array.from(a);
    this.b = Array.from(b);
    this.b2j = indexB(this.b, opts.autojunk ?? true);
  }

  matchingBlocks(): Block[] {
    this.blocks ??= collapseAdjacent(this.findBlocks(), this.a.length, this.b.length);
    return this.blocks.map((block) => ({ ...block }));
  }

  opcodes(): Opcode[] {
    const answer: Opcode[] = [];
    let i = 0;
    let j = 0;
    for (const { a: ai, b: bj, size } of this.matchingBlocks()) {
      const tag = gapTag(i < ai, j < bj);
      if (tag) answer.push([tag, i, ai, j, bj]);
      i = ai + size;
      j = bj + size;
      if (size) answer.push(["equal", ai, i, bj, j]);
    }
    return answer;
  }

  /** `2 * matches / (len(a) + len(b))`, and 1 when both are empty. */
  ratio(): number {
    const matches = this.matchingBlocks().reduce((sum, block) => sum + block.size, 0);
    const total = this.a.length + this.b.length;
    return total ? (2.0 * matches) / total : 1.0;
  }

  private findBlocks(): Block[] {
    const found: Block[] = [];
    const queue: Range[] = [[0, this.a.length, 0, this.b.length]];
    for (let range = queue.pop(); range; range = queue.pop()) {
      const [alo, ahi, blo, bhi] = range;
      const match = this.findLongestMatch(alo, ahi, blo, bhi);
      if (!match.size) continue;
      found.push(match);
      if (alo < match.a && blo < match.b) queue.push([alo, match.a, blo, match.b]);
      if (match.a + match.size < ahi && match.b + match.size < bhi) {
        queue.push([match.a + match.size, ahi, match.b + match.size, bhi]);
      }
    }
    return found.sort((x, y) => x.a - y.a || x.b - y.b || x.size - y.size);
  }

  private findLongestMatch(alo: number, ahi: number, blo: number, bhi: number): Block {
    let best: Block = { a: alo, b: blo, size: 0 };
    let j2len = new Map<number, number>();
    for (let i = alo; i < ahi; i++) {
      const next = new Map<number, number>();
      for (const j of this.b2j.get(this.a[i]!) ?? []) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len.get(j - 1) ?? 0) + 1;
        next.set(j, k);
        if (k > best.size) best = { a: i - k + 1, b: j - k + 1, size: k };
      }
      j2len = next;
    }
    return this.extendOverEqualNeighbours(best, alo, ahi, blo, bhi);
  }

  /** Grows the match across neighbours that `b2j` dropped as popular. CPython's junk passes are no-ops without `isjunk`. */
  private extendOverEqualNeighbours(match: Block, alo: number, ahi: number, blo: number, bhi: number): Block {
    let { a: i, b: j, size } = match;
    while (i > alo && j > blo && this.a[i - 1] === this.b[j - 1]) {
      i--;
      j--;
      size++;
    }
    while (i + size < ahi && j + size < bhi && this.a[i + size] === this.b[j + size]) size++;
    return { a: i, b: j, size };
  }
}

function indexB<T>(b: readonly T[], autojunk: boolean): Map<T, number[]> {
  const b2j = new Map<T, number[]>();
  b.forEach((item, j) => {
    const indices = b2j.get(item);
    if (indices) indices.push(j);
    else b2j.set(item, [j]);
  });
  if (autojunk && b.length >= AUTOJUNK_MIN_LENGTH) {
    const ntest = Math.floor(b.length / 100) + 1;
    for (const [item, indices] of b2j) if (indices.length > ntest) b2j.delete(item);
  }
  return b2j;
}

function collapseAdjacent(sorted: readonly Block[], la: number, lb: number): Block[] {
  const out: Block[] = [];
  let run: Block = { a: 0, b: 0, size: 0 };
  for (const block of sorted) {
    if (run.a + run.size === block.a && run.b + run.size === block.b) {
      run.size += block.size;
      continue;
    }
    if (run.size) out.push(run);
    run = { ...block };
  }
  if (run.size) out.push(run);
  out.push({ a: la, b: lb, size: 0 });
  return out;
}

function gapTag(aGap: boolean, bGap: boolean): OpcodeTag | undefined {
  if (aGap && bGap) return "replace";
  if (aGap) return "delete";
  if (bGap) return "insert";
  return undefined;
}
