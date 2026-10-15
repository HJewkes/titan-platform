import nlp from "compromise";
import { governingTag, punctTag, wordTag } from "./penn-rules.js";
import type { PosTagger, RawToken } from "./types.js";

interface Term {
  start: number;
  end: number;
  tags: ReadonlySet<string>;
}

interface CompromiseSentence {
  terms: { offset: { start: number; length: number }; tags: string[] }[];
}

function termsOf(text: string): Term[] {
  const sentences = nlp(text).json({ offset: true }) as CompromiseSentence[];
  return sentences
    .flatMap((s) => s.terms)
    .filter((t) => t.offset.length > 0)
    .map((t) => ({
      start: t.offset.start,
      end: t.offset.start + t.offset.length,
      tags: new Set(t.tags),
    }));
}

// compromise has no term for clitics and punctuation, so a token takes the tags of the term it overlaps most.
function overlappingTags(tok: RawToken, terms: readonly Term[]): ReadonlySet<string> {
  const lo = tok.idx;
  const hi = tok.idx + tok.text.length;
  let best: Term | null = null;
  let bestLen = 0;
  for (const t of terms) {
    const len = Math.min(hi, t.end) - Math.max(lo, t.start);
    if (len > bestLen) {
      best = t;
      bestLen = len;
    }
  }
  return best ? best.tags : new Set();
}

const HAS_WORD_CHAR = /[\p{L}\p{N}]/u;

/** A Penn Treebank tagger over spaCy-style tokens, backed by compromise. */
export function compromiseTagger(): PosTagger {
  return {
    tag(text, tokens) {
      const terms = termsOf(text);
      const penn: string[] = [];
      const words: string[] = [];
      tokens.forEach((tok, i) => {
        const tag = HAS_WORD_CHAR.test(tok.text)
          ? wordTag(tok.text, overlappingTags(tok, terms), {
              governing: governingTag(penn, words),
              nextWord: tokens[i + 1]?.text.toLowerCase(),
            })
          : punctTag(tok, tokens[i - 1]);
        penn.push(tag);
        words.push(tok.text.toLowerCase());
      });
      return penn;
    },
  };
}
