import { roundMillis } from "./round.js";
import type { Word } from "./schemas.js";
import { SequenceMatcher } from "./sequence-matcher.js";

type Span = readonly [start: number, end: number];

function alignKey(word: string): string {
  return word.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Times each script word from what the recogniser heard. A word matched to a heard word
 * takes its times; a run of unmatched words between two anchors shares the gap evenly.
 * The first heard word's start and the last heard word's end anchor the two ends.
 */
export function align(script: readonly string[], heard: readonly Word[]): Word[] {
  const first = heard[0];
  const last = heard[heard.length - 1];
  if (!first || !last) throw new Error("align needs at least one heard word to anchor the script");
  const matched = matchedSpans(script, heard);
  const edges: (Span | undefined)[] = [[first.start, first.start], ...matched, [last.end, last.end]];
  fillGaps(edges);
  return script.map((text, k) => {
    const [start, end] = edges[k + 1]!;
    return { text, start: roundMillis(start), end: roundMillis(end) };
  });
}

function matchedSpans(script: readonly string[], heard: readonly Word[]): (Span | undefined)[] {
  const keys = heard.map((word) => alignKey(word.text));
  const spans = new Array<Span | undefined>(script.length).fill(undefined);
  const matcher = new SequenceMatcher(script.map(alignKey), keys, { autojunk: false });
  for (const block of matcher.matchingBlocks()) {
    for (let k = 0; k < block.size; k++) {
      const word = heard[block.b + k]!;
      spans[block.a + k] = [word.start, word.end];
    }
  }
  return spans;
}

/** `edges` starts and ends with an anchor, so every run of holes has a span on both sides. */
function fillGaps(edges: (Span | undefined)[]): void {
  let i = 1;
  while (i < edges.length - 1) {
    if (edges[i]) {
      i++;
      continue;
    }
    let j = i;
    while (!edges[j]) j++;
    const t0 = edges[i - 1]![1];
    const step = (edges[j]![0] - t0) / (j - i);
    for (let k = i; k < j; k++) edges[k] = [t0 + step * (k - i), t0 + step * (k - i + 1)];
    i = j;
  }
}
