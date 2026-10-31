import { sentencesOf, wordsOf } from "./lint-text.js";

/** Whether the beat guard refuses a new sentence for its length. */
type Overlong = (sentence: string) => boolean;

// A piece this short reads as a fragment rather than a sentence of its own.
const MIN_PIECE_WORDS = 4;

// Comma joints where a long spoken sentence splits into two without changing what it says.
const JOINT = /, (and|but|or|so|then|because|since|which) /g;

const LEADS: Readonly<Record<string, string>> = {
  and: "And",
  but: "But",
  or: "Or",
  so: "So",
  then: "Then",
  because: "That's because",
  since: "That's because",
  which: "That",
};

// "That" stands in for "which" only before a singular verb: "which carries it" reads as "That carries it".
const SINGULAR_VERB = /^(?:is|was|has|[a-z]+s)\b/;

interface Split {
  left: string;
  right: string;
  longer: number;
}

function splitsOf(sentence: string): Split[] {
  return [...sentence.matchAll(JOINT)].flatMap((match) => {
    const rest = sentence.slice(match.index + match[0].length);
    if (match[1] === "which" && !SINGULAR_VERB.test(rest)) return [];
    const left = `${sentence.slice(0, match.index)}.`;
    const right = `${LEADS[match[1]!]} ${rest}`;
    const sizes = [wordsOf(left).length, wordsOf(right).length];
    return Math.min(...sizes) >= MIN_PIECE_WORDS ? [{ left, right, longer: Math.max(...sizes) }] : [];
  });
}

/** The sentence split at its most even joint, each piece again while it is still too long; unchanged when no joint fits. */
function splitSentence(sentence: string, overlong: Overlong): string {
  if (!overlong(sentence)) return sentence;
  const best = splitsOf(sentence).sort((a, b) => a.longer - b.longer)[0];
  return best ? `${splitSentence(best.left, overlong)} ${splitSentence(best.right, overlong)}` : sentence;
}

const norm = (text: string): string => text.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * A rewritten line with each new sentence the guard would refuse for length split at a clause joint (TP-4685). The
 * model overshoots the planned length, mostly once numbers are spelled out, and a split keeps every word it chose
 * where a refusal throws the whole beat away. A sentence the original already said is left alone, as the guard does.
 */
export function splitOverlong(before: string, spoken: string, overlong: Overlong): string {
  const inherited = new Set(sentencesOf(before).map(norm));
  return sentencesOf(spoken).reduce(
    (line, sentence) => (inherited.has(norm(sentence)) ? line : line.replace(sentence, () => splitSentence(sentence, overlong))),
    spoken,
  );
}
