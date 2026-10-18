/** A match: where it starts, its text, and the name the head captured, if any. */
export interface SubscriptedMatch {
  index: number;
  0: string;
  name: string | undefined;
}

/**
 * The matches of `head`, then up to `maxSubscripts` `[…]` groups after a name it captured, then `tail`, left to right
 * without overlap, as a global regex `head(?:\[[^\]]*\])*tail` finds them. That regex reads every opener's group to
 * the same far `]`, which is quadratic in the openers (`${x[${x[…]`); here each group's end is looked up.
 * `head` must be global and capture any name as group 1; `tail` must be sticky and never begin with `[`, so a match
 * with fewer groups than there are is no match.
 */
export function subscriptedMatches(text: string, head: RegExp, maxSubscripts: number, tail: RegExp): SubscriptedMatch[] {
  const heads = new RegExp(head);
  const ends = new RegExp(tail);
  const out: SubscriptedMatch[] = [];
  let closes: Int32Array | undefined;
  for (let m = heads.exec(text); m !== null; m = heads.exec(text)) {
    let at = heads.lastIndex;
    if (m[1] !== undefined && text[at] === "[") at = pastSubscripts(text, at, (closes ??= nextCloses(text)), maxSubscripts);
    ends.lastIndex = at;
    if (ends.test(text)) {
      out.push({ index: m.index, 0: text.slice(m.index, ends.lastIndex), name: m[1] });
      heads.lastIndex = ends.lastIndex;
    } else heads.lastIndex = m.index + 1;
  }
  return out;
}

/** For each index of a text, where the next `]` at or after it sits, or the text's length when none does. */
function nextCloses(text: string): Int32Array {
  const out = new Int32Array(text.length + 1).fill(text.length);
  for (let i = text.length - 1; i >= 0; i--) out[i] = text[i] === "]" ? i : (out[i + 1] ?? text.length);
  return out;
}

/** Where up to `max` `[…]` groups from `at` end, each closed by the next `]`. */
function pastSubscripts(text: string, at: number, closes: Int32Array, max: number): number {
  let end = at;
  for (let n = 0; n < max && text[end] === "["; n++) {
    const close = closes[end] ?? text.length;
    if (close >= text.length) break;
    end = close + 1;
  }
  return end;
}
